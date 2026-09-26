// src/integrations/connections.ts — what the three providers (slack.ts, google.ts, github.ts) share.
// A CONNECTION is a name a project picks: its credential is the secret `/secrets/<provider>-<name>`,
// its inbound events land on the plain context log `/integrations/<provider>/<name>`, and its record
// is two platform facts on the project root, `events.iterate.com/<provider>/connected` and
// `…/disconnected`, which the project processor folds into `state.integrations` (the Dash's list).
// The project facet (project/durable-object.ts) runs connect and disconnect, and finishes a connect
// when the provider's callback comes back; the webhooks are plain fetch functions in worker.ts.
import { errorCode } from "iterate/lib";
import type { StreamEventInput } from "iterate/stream/processor";
import { z } from "zod";
import { appConfigOf, sessionSigningSecretOf, type AppConfigEnv } from "../app-config.ts";
import { bytesFromBase64url, signClaims } from "../caller.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import { ControlPlane, type Reach } from "../control-plane/edge.ts";
import type { Env } from "../env.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { ProjectState } from "../project/contract.ts";
import type { IntegrationConnectionRow, IntegrationProvider } from "./contract.ts";

export type { IntegrationProvider };

/** The bindings a provider acts through. */
export type IntegrationEnv = Pick<Env, "DB" | "ITERATE_CONTEXT"> & AppConfigEnv;

/** The owner facet's reach, for connect, finish and disconnect: the project (or, for a person's own
 *  connection, the global namespace and `rootPath` `/users/<id>`), its bindings, the caller's itx
 *  on the owner's root, and the facet's storage, where a connect's attempt waits for its callback. */
export type IntegrationScope = {
  env: IntegrationEnv;
  projectId: string;
  /** The owner's root: a project's `/`, a person's `/users/<id>`. */
  rootPath: string;
  withItx: <T>(call: (itx: ItxEntrypointScope) => T) => Promise<Awaited<T>>;
  storage: DurableObjectStorage;
};

/** A connect in flight, kept by the owner's facet until the provider's callback finishes it (or a
 *  disconnect drops it, so a late callback finishes nothing): whose app, where the provider answers,
 *  and until when. GitHub's also carries its nonce and what its callback needs. */
export type ConnectionAttempt = {
  client: "iterate" | "project";
  origin: string;
  until: number;
  /** A person's connect a project asked for (`itx.integrations.connect(provider, { account })` on
   *  it, the account lacking scopes): once the consent granted `requiredScopes`, the account is
   *  connected to that project — unless `reconnect` (the project had it already) and the project
   *  disconnected it meanwhile. */
  connectToProject?: { projectId: string; requiredScopes: string[]; reconnect: boolean };
  /** Its finish began (verbs.ts `finishIntegrationConnect`), claimed before any call out: a second
   *  callback for the same consent — concurrent, or a refresh — never runs it again. */
  finishing?: true;
  /** Why that finish refused to connect the account to the project: a refresh refuses the same. */
  refused?: { code: "FORBIDDEN" | "INVALID_INPUT"; message: string };
};

/** The providers whose accounts iterate's app routes to one connection each (control-plane/catalog.ts
 *  `integration_routes`): the ones an account is moved between projects of. */
export const ROUTED_PROVIDERS = ["slack", "github"] as const satisfies IntegrationProvider[];
export type RoutedProvider = (typeof ROUTED_PROVIDERS)[number];

/** THE MOVE OF AN ACCOUNT ANOTHER PROJECT HOLDS (verbs.ts `confirmIntegrationMove`): the human
 *  proved they may connect it (GitHub: they administer the installation's account; Slack: Slack
 *  let them install into the workspace), and another project's connection holds its route. What
 *  moving it here takes, and how far the move got: `moving` once a confirmation claimed it, `moved`
 *  once the route and the connection are here and only the holder's cleanup is left, which the same
 *  offer retries. */
export type IntegrationMove = {
  externalId: string;
  account: string;
  holder: { projectId: string; path: string };
  stage?: "moving" | "moved";
  /** Slack: the consent whose token the connection's secret holds aside, unused, until the move
   *  (secret/durable-object.ts `admitHeldToken`). GitHub keeps none: the installation's token is
   *  minted on use. */
  heldTokenNonce?: string;
};

/** A connect whose account another project holds, waiting at `attemptKeyOf(provider, connection)`
 *  for the human's confirmation until `until`: its nonce, which the offer names and the move spends. */
export type MovableAttempt = ConnectionAttempt & { nonce: string; move?: IntegrationMove };

/** The platform-signed offer to move an account here, which a provider's callback hands the human's
 *  landing (`?move=`): the connection it moves to, the attempt it belongs to (its nonce), the account,
 *  and the project holding it — by its slug, and only when the human can see that project. */
export type IntegrationMoveOffer = {
  kind: "integration-move";
  provider: RoutedProvider;
  projectId: string;
  connection: string;
  nonce: string;
  externalId: string;
  account: string;
  holderSlug: string | null;
  exp: number;
};

/** What a provider's callback signs into the offer, and the project holding the account (named in
 *  the offer only if the human reaches it). */
export type MoveOffered = Omit<IntegrationMoveOffer, "kind" | "holderSlug"> & {
  holderProjectId: string;
};

/** A consent's token its secret held aside because another project holds the account
 *  (secret/durable-object.ts `completeOAuth`): the account, and until when a move can admit it. */
export type HeldToken = { externalId: string; account: string; until: number };

/** How long a move offer stands: the human reads one sentence and presses one button. */
export const MOVE_OFFER_TTL_MS = 10 * 60_000;

const PROVIDER_TITLES: Record<RoutedProvider, string> = { slack: "Slack", github: "GitHub" };

/** The provider and connection a move offer names, read before its signature is checked — for
 *  serializing its confirmation on that connection only; `confirmIntegrationMove` verifies it. */
export function moveOfferConnectionOf(offer: unknown): { provider: string; connection: string } {
  try {
    const claims = z
      .object({ provider: z.string(), connection: z.string() })
      .safeParse(
        JSON.parse(new TextDecoder().decode(bytesFromBase64url(String(offer).split(".")[0]!))),
      );
    return claims.success ? claims.data : { provider: "", connection: "" };
  } catch {
    return { provider: "", connection: "" };
  }
}

/** A callback's answer once the account turned out to be held by another project: the human's
 *  landing with the signed offer (`?move=`), naming the holder only when `reach` reaches it; with
 *  nowhere to land, a 409 that says where to move it from. */
export async function moveOfferLanding(
  env: Env,
  reach: Reach,
  move: MoveOffered,
  landing: string | null,
): Promise<Response> {
  const { holderProjectId, ...offered } = move;
  const controlPlane = new ControlPlane(env);
  const holderSlug = (await controlPlane.reachesProject(reach, holderProjectId))
    ? ((await controlPlane.getProject(holderProjectId))?.slug ?? null)
    : null;
  if (!landing)
    return new Response(
      `The ${PROVIDER_TITLES[move.provider]} account ${move.account} is connected to ${holderSlug || "another project"}. Connect it from the Dash's Integrations page to move it here.\n`,
      {
        status: 409,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      },
    );
  const offer: IntegrationMoveOffer = { kind: "integration-move", ...offered, holderSlug };
  const url = new URL(landing);
  url.searchParams.set(
    "move",
    await signClaims(offer, await sessionSigningSecretOf(appConfigOf(env))),
  );
  return new Response(null, {
    status: 303,
    headers: { location: url.href, "cache-control": "no-store" },
  });
}

/** A connection's name: a secret name's grammar, so `/secrets/<provider>-<name>` always is one. */
export function assertConnectionName(connection: unknown): string {
  if (typeof connection !== "string" || !/^(?!\.\.?$)[a-zA-Z0-9._-]{1,64}$/.test(connection))
    throw new Error(
      `integrations: a connection's name is 1–64 of [a-zA-Z0-9._-], got ${JSON.stringify(connection)}`,
    );
  return connection;
}

export const connectionPathOf = (provider: IntegrationProvider, connection: string) =>
  `/integrations/${provider}/${connection}`;
export const tokenSecretPathOf = (provider: IntegrationProvider, connection: string) =>
  `/secrets/${provider}-${connection}`;
export const attemptKeyOf = (provider: IntegrationProvider, connection: string) =>
  `integration-attempt:${provider}/${connection}`;
/** A consent's attempt (Slack, Google, Cloudflare): keyed by the OAuth attempt's nonce too, so the
 *  callback finishes the attempt it completed, never one begun after it on the same connection. */
export const consentAttemptKeyOf = (
  provider: IntegrationProvider,
  connection: string,
  nonce: string,
) => `${attemptKeyOf(provider, connection)}#${nonce}`;

/** Every attempt in flight on a connection dropped (a disconnect): a late callback finishes none. */
export async function dropAttemptsOf(
  storage: DurableObjectStorage,
  provider: IntegrationProvider,
  connection: string,
): Promise<void> {
  const key = attemptKeyOf(provider, connection);
  const keys = [key, ...(await storage.list({ prefix: `${key}#` })).keys()];
  await storage.delete(keys);
}

/** One event onto a project context's log as the platform's own (`source.platform`, no principal):
 *  a connection's `connected`/`disconnected` on `/`, a webhook on the connection's log. */
export async function appendPlatformFact(
  env: IntegrationEnv,
  projectId: string,
  path: string,
  event: StreamEventInput,
): Promise<void> {
  await env.ITERATE_CONTEXT.getByName(DurableObjectNameCodec.stringify({ projectId, path })).invoke(
    ["itx", "builtins", ["append", event]],
    [],
    { principal: null, platform: true },
  );
}

/** A request through the owner root's egress, so a `getSecret(…)` placeholder is substituted in
 *  its secret's facet, the only code that holds the value. */
export function ownerEgress(
  env: IntegrationEnv,
  owner: { projectId: string; rootPath: string },
  request: Request,
): Promise<Response> {
  return env.ITERATE_CONTEXT.getByName(
    DurableObjectNameCodec.stringify({ projectId: owner.projectId, path: owner.rootPath }),
  ).fetch(request);
}

/** The connection a project root records at `path` (`state.integrations`), or null. */
export async function connectionRowOf(
  env: IntegrationEnv,
  projectId: string,
  path: string,
): Promise<IntegrationConnectionRow | null> {
  // The platform's own read of the project facet; `invoke` is untyped across the DO hop, and
  // `snapshot` answers the project contract's state.
  const { state } = (await env.ITERATE_CONTEXT.getByName(
    DurableObjectNameCodec.stringify({ projectId, path: "/" }),
  ).invoke(["itx", "builtins", "facets", ["get", "project"], ["snapshot"]], [], {
    principal: null,
  })) as { state: ProjectState };
  return Object.hasOwn(state.integrations, path) ? state.integrations[path]! : null;
}

/** Route a provider account to the connection at `path` (iterate's app routes its webhooks there)
 *  for as long as `land` takes — the connection's own facts. When `land` fails, the connection's
 *  routes go back to what they were: none for a new connection, the account it held for one that
 *  was connected already (a reconnect asking for more), so a failed reconnect never unroutes a
 *  connection the project still lists. */
export async function routedWhile<T>(
  env: IntegrationEnv,
  route: { provider: IntegrationProvider; externalId: string; projectId: string; path: string },
  land: () => Promise<T>,
): Promise<T> {
  const { provider, externalId, projectId, path } = route;
  const controlPlane = new ControlPlane(env);
  const before = await connectionRowOf(env, projectId, path);
  await controlPlane.routeIntegration(provider, externalId, projectId, path);
  try {
    return await land();
  } catch (error) {
    await controlPlane.releaseIntegrationRoutes(projectId, path);
    if (before?.client === "iterate")
      await controlPlane.routeIntegration(provider, before.externalId, projectId, path);
    throw error;
  }
}

/** The answer to a signed webhook that is not for any connection here: 200, so the provider keeps
 *  delivering to every other workspace or installation (rules.ts). */
export const ignoredWebhook = (reason: string) => Response.json({ ok: true, ignored: reason });

/** A disconnect's delete of the connection's secret: one never set (a consent never finished, or
 *  a delete that already ran) is gone already; any other failure is the caller's, so the disconnect
 *  fails with the row standing and can be retried, never reporting a token gone that is not. */
export async function deleteTokenSecret(
  scope: Pick<IntegrationScope, "withItx">,
  provider: IntegrationProvider,
  connection: string,
): Promise<void> {
  await scope
    .withItx((itx) => itx.secrets.delete(tokenSecretPathOf(provider, connection)))
    .catch((error: unknown) => {
      if (errorCode(error) !== "SECRET_NOT_SET") throw error;
    });
}
