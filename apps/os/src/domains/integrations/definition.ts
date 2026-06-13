// What an integration IS. One IntegrationDefinition per provider
// (registry.ts). Deliberately thin — conventions and symmetry, not a
// framework:
//
// - From the ingress worker's perspective an integration is just a PARTIAL
//   FETCH FUNCTION: `fetch(request) → Response | null`. Each provider owns its
//   whole webhook handling imperatively (URL match, signature check, protocol
//   handshakes) and calls the one shared primitive — captureIntegrationEvent —
//   to durably land the raw event on the global ingress stream.
// - Providers that listen instead of being called (Discord's gateway) hold
//   their connection in their own Durable Object and call the SAME capture
//   primitive, so everything downstream is transport-blind.
// - `createSdk` builds the well-known SDK that itx.integrations.{slug}.**
//   path-replays into.
//
// Kept free of cloudflare:workers imports so Node-side tests can exercise
// provider logic (signature verification, routing keys, SDK shape) directly:
// the two effectful doors (capture, env) come in as arguments.
//
// FIRST-PARTY vs CUSTOMER-OWNED is a property of a CONNECTION, not of a
// definition: the same `github` definition serves a project using iterate's
// GitHub app (first-party: our client secret, webhooks on os.iterate.com) and
// a project that registered its own app (customer-owned: client credentials
// live as that project's Secrets, webhooks arrive on the project's own
// hostname). The `integration/connected` event records which one a project
// chose; ingress and SDK construction resolve credentials accordingly.

import type { AppConfig } from "~/config.ts";
import type { SecretDerivation } from "~/domains/secrets/secret-derivation.ts";
import type {
  SecretSensitivity,
  SecretTier,
} from "~/domains/secrets/stream-processors/secret/contract.ts";
import type { OAuthStatePayload } from "~/domains/secrets/oauth-state.ts";

export type IntegrationTransport = "webhook" | "gateway";

/** What a provider hands to ctx.connect — the integration slug is implied. */
export type IntegrationConnectInput = {
  account?: string;
  projectId: string;
  ownership: "first-party" | "customer";
  externalId: string;
  displayName?: string;
  routingKeys: string[];
  secrets: {
    name: string;
    material?: string;
    metadata?: Record<string, unknown>;
    tier?: SecretTier;
    sensitivity?: SecretSensitivity;
    derivation?: SecretDerivation;
    expiresAt?: string;
  }[];
};

/** The one side-effect channel of integration ingress: capture a provider
 * event verbatim on `{global}:/integrations/{slug}/webhooks`. Only this
 * durable append gates a webhook 200; routing happens after the ack. */
export type CaptureIntegrationEvent = (input: {
  transport: IntegrationTransport;
  /** Provider-side owner of the event (installation, guild, team) — the key
   * the ingress router resolves to a project. */
  routingKey: string | null;
  /** Stable provider-side delivery id so retries dedupe on append. */
  idempotencyKey: string | null;
  body: unknown;
}) => Promise<void>;

export type IntegrationIngressContext = {
  request: Request;
  /** Deployment config (first-party verification secrets). Customer-owned
   * connections resolve the same values from project Secrets instead. */
  env: Record<string, string | undefined>;
  /** Parsed app config — first-party OAuth clients live at
   * config.integrations.{slug}. */
  config: AppConfig;
  /** The app's base URL, for OAuth redirect URIs. */
  baseUrl: string;
  capture: CaptureIntegrationEvent;
  /** STATELESS OAuth state (HMAC-signed, 10-minute expiry) — no table. */
  oauthState: {
    sign(payload: Omit<OAuthStatePayload, "expiresAtMs">): Promise<string>;
    verify(state: string): Promise<OAuthStatePayload | null>;
  };
  /** The ONE connect choreography: appends integration/connect-requested for
   * this integration; the account's processor does the rest. */
  connect(input: IntegrationConnectInput): Promise<unknown>;
  /** Who currently owns a routing key (the ingress router's fold) — the
   * conflict check behind the takeover interstitial. */
  routeOwner(input: { routingKey: string }): Promise<{ projectId: string; account: string } | null>;
  /** Seal a PendingConnect for the takeover interstitial: the callback
   * already exchanged the code (codes are single-use), so the full connect
   * input — credentials included — rides encrypted to the UI and back. */
  sealPendingConnect(input: PendingConnect): Promise<string>;
};

/** A connect that paused for user consent: the routing key is owned by a
 * different project, and moving it needs the explicit takeover interstitial. */
export type PendingConnect = {
  integration: string;
  connect: IntegrationConnectInput;
  conflict: {
    routingKey: string;
    owner: { projectId: string; account: string };
  };
};

export type IntegrationSdkContext = {
  projectId: string;
  /** Which ACCOUNT of the integration this SDK speaks for ("default" for the
   * unnamed common case) — the instance dimension. */
  account: string;
  /**
   * A PLACEHOLDER reference to a provided Secret — pretend it IS the secret.
   * Hand it to the SDK as the token (`new Octokit({ auth:
   * ctx.secretRef("access-token") })`); it substitutes (with inline
   * derivation) at the egress hop `ctx.fetch` routes through. No SDK ever
   * holds material — exactly the userspace convention, applied to
   * first-party providers.
   */
  secretRef(name: string): string;
  /** The substituting egress fetch — bind it into the SDK (octokit's
   * `request.fetch`, discord REST's `makeRequest`). It IS the terminal
   * egress pipe, so first-party SDK traffic leaves through the same door as
   * project code's bare fetch(). */
  fetch: typeof fetch;
};

export type ProvidedSecretSpec = {
  /** Name within the account: the Secret lives at
   * `/secrets/{integration}/{account}/{name}` in the connected project. */
  name: string;
  description: string;
};

/** The account-scoped Secret slug convention. */
export function providedSecretSlug(input: {
  integration: string;
  account: string;
  name: string;
}): string {
  return `${input.integration}/${input.account}/${input.name}`;
}

export type IntegrationDefinition = {
  slug: string;
  displayName: string;
  /** Prose for itx describe(): what itx.integrations.{slug}.** exposes. */
  instructions: string;
  /** The partial fetch function: null if the request isn't this integration's. */
  fetch?(ctx: IntegrationIngressContext): Promise<Response | null>;
  /** Secrets this integration PROVIDES to a connected project. Integrations
   * are secret providers; customer-owned connections make them secret USERS
   * too (their OAuth client credentials are Secrets). */
  providedSecrets: ProvidedSecretSpec[];
  /** Build the object itx.integrations.{slug}.** path-replays into — the
   * well-known SDK, ready-authenticated. */
  createSdk(ctx: IntegrationSdkContext): Promise<object>;
};
