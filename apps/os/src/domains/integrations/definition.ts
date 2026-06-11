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

export type IntegrationTransport = "webhook" | "gateway";

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
  capture: CaptureIntegrationEvent;
};

export type IntegrationSdkContext = {
  projectId: string;
  /** Audited material dereference via the Secret DO (platform-trusted only —
   * this runs inside the IntegrationsCapability loopback, never in project
   * worker isolates). */
  getSecretMaterial(slug: string): Promise<string>;
};

export type ProvidedSecretSpec = {
  /** Secret slug → stream `/secrets/{slug}` in the connected project. */
  slug: string;
  description: string;
  /** First-party deployment-level fallback (Doppler) so dev environments work
   * before a per-project connect flow has run. */
  firstPartyEnvFallback?: string;
};

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
