import { env as workerEnv } from "cloudflare:workers";

/**
 * The binding contract every next-engine worker is deployed with (alchemy.run.ts
 * binds these names identically in each next-hosting worker).
 *
 * apps/os declares a repo-wide ambient `Env` for the legacy workers
 * (src/lib/worker-env.d.ts). The next engine deliberately does not participate
 * in that union while both stacks coexist: next code imports this `Env` and the
 * `nextEnv` accessor explicitly, so neither stack's types leak into the other.
 */
export interface Env {
  AI: Ai;
  ARTIFACTS: Artifacts;
  ARTIFACTS_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
  LOADER: WorkerLoader;
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

export const nextEnv = workerEnv as unknown as Env;
