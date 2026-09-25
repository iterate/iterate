// src/integrations/connections.ts — what the three providers (slack.ts, google.ts, github.ts) share.
// A CONNECTION is a name a project picks: its credential is the secret `/secrets/<provider>-<name>`,
// its inbound events land on the plain context log `/integrations/<provider>/<name>`, and its record
// is two platform facts on the project root, `events.iterate.com/<provider>/connected` and
// `…/disconnected`, which the project processor folds into `state.integrations` (the Dash's list).
// The project facet (project/durable-object.ts) runs connect and disconnect, and finishes a connect
// when the provider's callback comes back; the webhooks are plain fetch functions in worker.ts.
import type { StreamEventInput } from "iterate/stream/processor";
import type { AppConfigEnv } from "../app-config.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
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

/** A connect in flight, kept by the project facet until the provider's callback finishes it (or a
 *  disconnect drops it, so a late callback finishes nothing): whose app, where the provider answers,
 *  and until when. GitHub's also carries its nonce and what its callback needs. */
export type ConnectionAttempt = {
  client: IntegrationConnectionRow["client"];
  origin: string;
  until: number;
};

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
