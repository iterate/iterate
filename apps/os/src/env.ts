import { env as workerEnv } from "cloudflare:workers";

/**
 * The OS worker's binding contract — the binding names wrangler.jsonc
 * (generated from the root envs.ts) declares on the single worker
 * (src/worker.ts). The repo-wide ambient `Env` (src/lib/worker-env.d.ts) is
 * this same interface.
 */
export interface Env {
  AI: Ai;
  /**
   * This worker's own deployed name (e.g. "os-prd"). Part of worker-loader
   * cache keys so dynamic-worker isolates are attributed to the worker that
   * created them (a dynamic isolate carries its creator's loopback binding
   * stubs — invoking it from a different parent fails with a redacted
   * internal error).
   */
  WORKER_SELF: string;
  ARTIFACTS: Artifacts;
  ARTIFACTS_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
  LOADER: WorkerLoader;
  /** Slug -> project id (+ metadata) cache in front of the auth worker's
   * project directory (project-directory.ts). */
  PROJECT_DIRECTORY: KVNamespace;
  /**
   * Cloudflare Email Service send binding backing `itx.email`. Bound in every
   * wrangler env block including local dev, where miniflare simulates sends
   * (logs + local .eml files) instead of delivering real mail.
   */
  EMAIL: import("./domains/email/utils.ts").SendEmailBinding;
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
  SANDBOX: DurableObjectNamespace<
    import("./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts").CloudflareSandboxDurableObject
  >;
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
