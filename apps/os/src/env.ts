import { env as workerEnv } from "cloudflare:workers";
import type { AuthWorkerRpc } from "@iterate-com/auth-contract";

/**
 * The auth worker's RPC entrypoint as seen through the `AUTH` service
 * binding. The `Rpc.WorkerEntrypointBranded` marker is what `Service<T>`
 * needs to surface the methods as callable stubs; the method shapes come
 * from the shared contract. Same pattern as alchemy's own `WorkerRef<RPC>`
 * docstring example, and the branded-interface variant of
 * https://developers.cloudflare.com/workers/runtime-apis/rpc/typescript/ —
 * importing the worker class type from apps/auth would drag its whole env
 * type graph across the app boundary.
 */
export interface AuthWorkerEntrypoint extends Rpc.WorkerEntrypointBranded, AuthWorkerRpc {}

/**
 * The binding contract every itx worker is deployed with (alchemy.run.ts
 * binds these names identically in each of them).
 *
 * The repo-wide ambient `Env` (src/lib/worker-env.d.ts) covers the two
 * dashboard-side workers (app + ingress); the itx workers deliberately do not
 * participate in that union — they import this `Env` and the `itxEnv`
 * accessor explicitly, so neither side's types leak into the other.
 */
export interface Env {
  AI: Ai;
  ARTIFACTS: Artifacts;
  ARTIFACTS_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
  /**
   * Service binding to the auth worker's RPC entrypoint (apps/auth) — the
   * project directory and prj_ id authority (see AuthWorkerRpc in
   * @iterate-com/auth-contract). Reach it via the `authWorker()` accessor
   * below, not directly.
   *
   * Holding the binding IS the credential: a service binding can only be
   * attached by a deploy into this Cloudflare account, so no service token
   * ships in worker config (it replaced HTTP calls carrying
   * x-iterate-service-token). alchemy.run.ts binds it in every deployed OS
   * worker and makes it required; in fully-local dev it's a remote binding
   * proxied to the deployed auth worker for the stage. Only the OIDC protocol
   * stays on auth's public hostname (browsers can't hold bindings).
   * https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
   * https://developers.cloudflare.com/workers/local-development/#remote-bindings
   */
  AUTH: Service<AuthWorkerEntrypoint>;
  LOADER: WorkerLoader;
  /** Slug -> project id (+ metadata) cache in front of the auth worker's
   * project directory (project-directory.ts). */
  PROJECT_DIRECTORY: KVNamespace;
  SECRET_ENCRYPTION_KEY: string;

  AGENT: DurableObjectNamespace<
    import("./domains/agents/agent-durable-object.ts").AgentDurableObject
  >;
  ITX: DurableObjectNamespace<import("./domains/itx/itx-durable-object.ts").ItxDurableObject>;
  PROJECT: DurableObjectNamespace<
    import("./domains/projects/project-durable-object.ts").ProjectDurableObject
  >;
  REPO: DurableObjectNamespace<import("./domains/repos/repo-durable-object.ts").RepoDurableObject>;
  SECRET: DurableObjectNamespace<
    import("./domains/secrets/secret-durable-object.ts").SecretDurableObject
  >;
  STREAM: DurableObjectNamespace<
    import("./domains/streams/stream-durable-object.ts").StreamDurableObject
  >;
  WORKER: DurableObjectNamespace<
    import("./domains/workers/stateful-worker-durable-object.ts").StatefulWorkerDurableObject
  >;
}

export const itxEnv = workerEnv as unknown as Env;

/** The auth worker over the AUTH service binding (see the `AUTH` field
 * docstring). A one-liner so app/ingress-side callers don't reach for the
 * itx-named env accessor; `Env.AUTH` is non-optional, bound in every deployed
 * worker. */
export const authWorker = () => itxEnv.AUTH;
