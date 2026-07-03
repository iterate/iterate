import { env as workerEnv } from "cloudflare:workers";

/**
 * The binding contract every engine worker is deployed with (alchemy.run.ts
 * binds these names identically in each of them).
 *
 * The repo-wide ambient `Env` (src/lib/worker-env.d.ts) covers the two
 * dashboard-side workers (app + ingress); the engine workers deliberately do not
 * participate in that union — they import this `Env` and the `itxEnv`
 * accessor explicitly, so neither side's types leak into the other.
 */
export interface Env {
  AI: Ai;
  /**
   * This worker's own deployed name (e.g. "os-prd-api"). Exists so
   * worker-loader cache keys are unique per hosting worker: local dev runs
   * every engine worker inside ONE workerd whose loader cache is shared across
   * them, and a dynamic worker isolate created by one parent carries that
   * parent's loopback binding stubs — invoking it from another parent fails
   * with a redacted internal error. In production each worker has its own
   * loader, so this is just a stable constant in the key.
   */
  WORKER_SELF: string;
  ARTIFACTS: Artifacts;
  ARTIFACTS_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
  LOADER: WorkerLoader;
  /** Slug -> project id (+ metadata) cache in front of the auth worker's
   * project directory (project-directory.ts). */
  PROJECT_DIRECTORY: KVNamespace;
  SECRET_ENCRYPTION_KEY: string;

  AGENT: DurableObjectNamespace<
    import("./domains/agents/agent-durable-object.ts").AgentDurableObject
  >;
  CAPABILITY_HOST: DurableObjectNamespace<
    import("./domains/capability-host/capability-host-durable-object.ts").CapabilityHostDurableObject
  >;
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
