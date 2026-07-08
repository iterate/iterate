import { env as workerEnv } from "cloudflare:workers";
import type { SendEmailBinding } from "./domains/email/utils.ts";

/**
 * The OS worker's binding contract — the binding names wrangler.jsonc
 * (generated from the root envs.ts) declares on the single worker
 * (src/worker.ts). The repo-wide ambient `Env` (src/lib/worker-env.d.ts) is
 * this same interface.
 */
export interface Env {
  AI: Ai;
  BROWSER: BrowserRun;
  IMAGES: ImagesBinding;
  MEDIA: MediaBinding;
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
  /** Worker Loader: hosts every dynamic worker isolate. Reach it through
   * DynamicWorkerRunner (domains/workers/worker-runner.ts) — its constructor
   * is where a dynamic isolate gets its scoped ITX binding and egress
   * fetcher. */
  LOADER: WorkerLoader;
  /** Slug -> project id (+ metadata) cache in front of the auth worker's
   * project directory (project-directory.ts). */
  PROJECT_DIRECTORY: KVNamespace;
  /**
   * Cloudflare Email Service send binding backing `itx.email`. Bound in every
   * wrangler env block including local dev, where miniflare simulates sends
   * (logs + local .eml files) instead of delivering real mail.
   */
  EMAIL: SendEmailBinding;
  SECRET_ENCRYPTION_KEY: string;
  /** Content-addressed dynamic worker build artifact cache
   * (domains/workers/artifact-store.ts). Every entry is reproducible from its
   * deterministic build key, so the namespace is safe to wipe. */
  WORKER_BUILD_CACHE: KVNamespace;
  /**
   * The builder sidecar (src/builder.ts): bundles dynamic worker source into
   * loader-ready artifacts, called on artifact-cache misses. The only script
   * carrying the bundler toolchain (esbuild-wasm, ~14MB) — the "+1" in the
   * one-worker topology, kept out of this script so the product stays small.
   * The builder does NOT carry this Env; its whole binding set is the
   * artifact cache (see its BuilderEnv).
   */
  BUILDER: Service<import("./domains/workers/builder-entrypoint.ts").BuilderEntrypoint>;

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
  /**
   * Sandbox container namespaces, ONE PER INSTANCE TYPE: Cloudflare fixes the
   * container instance type per container class, so each instance type is its own
   * Durable Object class and binding (src/domains/sandboxes/instance-types.ts is the
   * canonical table; the collection routes by the path's instance-type segment).
   */
  SANDBOX_LITE: DurableObjectNamespace<
    import("./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts").SandboxLiteDurableObject
  >;
  SANDBOX_BASIC: DurableObjectNamespace<
    import("./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts").SandboxBasicDurableObject
  >;
  SANDBOX_STANDARD_1: DurableObjectNamespace<
    import("./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts").SandboxStandard1DurableObject
  >;
  SANDBOX_STANDARD_2: DurableObjectNamespace<
    import("./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts").SandboxStandard2DurableObject
  >;
  SANDBOX_STANDARD_3: DurableObjectNamespace<
    import("./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts").SandboxStandard3DurableObject
  >;
  SANDBOX_STANDARD_4: DurableObjectNamespace<
    import("./domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts").SandboxStandard4DurableObject
  >;
  /**
   * Workspace persistence for sandbox containers. Container disk is
   * ephemeral — a sandbox that sleeps loses its filesystem — so the sandbox
   * Durable Object snapshots `/workspace` to this R2 bucket on idle and
   * restores it on the next start (the Sandbox SDK's backup/restore:
   * https://developers.cloudflare.com/sandbox/guides/backup-restore/). One
   * bucket per env (`${WORKER_SELF}-sandboxes`). The binding MUST be named
   * `BACKUP_BUCKET` — the SDK reads it from the env by that exact name.
   */
  BACKUP_BUCKET: R2Bucket;
  /** The {@link Env.BACKUP_BUCKET} bucket's name — the SDK presigns transfer
   * URLs against `https://{CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/
   * {BACKUP_BUCKET_NAME}/…`, so it needs the name, not just the binding. */
  BACKUP_BUCKET_NAME: string;
  /** Account owning {@link Env.BACKUP_BUCKET}, for the SDK's presigned URLs. */
  CLOUDFLARE_R2_ACCOUNT_ID: string;
  /**
   * R2 S3-API credentials for presigning backup transfers (optional Doppler
   * secret). When present, the SDK presigns `*.r2.cloudflarestorage.com` URLs
   * and the container transfers archives directly — fast, and through project
   * egress like all container traffic. When absent (local dev always; a
   * deployed env until someone mints keys), the sandbox falls back to the
   * SDK's bucket-binding transfer: archives stream through the Durable
   * Object's {@link Env.BACKUP_BUCKET} binding — slower, but zero-config and
   * the only mode `wrangler dev` supports.
   */
  R2_ACCESS_KEY_ID?: string;
  /** See {@link Env.R2_ACCESS_KEY_ID}. */
  R2_SECRET_ACCESS_KEY?: string;
  /**
   * Project file storage backing `itx.files` and agent file attachments
   * (domains/files/project-files.ts). Keys follow the durable-object name
   * convention `{projectId}.iterate{path}`; bytes are served publicly through
   * HMAC-signed URLs on the reserved `iterate-files` platform app. One bucket
   * per env (`${WORKER_SELF}-files`), created by ensure-resources.ts.
   */
  FILES_BUCKET: R2Bucket;
  /**
   * SPIKE: the search-index corpus behind `itx.search`
   * (domains/search/search-index.ts). Stream event segments, itx.files
   * mirrors, and repo file snapshots are written here under
   * `{projectId}/{streams|files|repos}/…` keys; a Cloudflare AI Search
   * instance (`${WORKER_SELF}-search`, created by ensure-resources.ts)
   * indexes the bucket and `itx.search` queries it with per-project folder
   * filters. One bucket per env (`${WORKER_SELF}-search-index`). The whole
   * bucket is derived data — safe to wipe and rebuild.
   */
  SEARCH_BUCKET: R2Bucket;
  SCHEDULER: DurableObjectNamespace<
    import("./domains/scheduler/scheduler-durable-object.ts").SchedulerDurableObject
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
  WORKSPACE: DurableObjectNamespace<
    import("./domains/workspaces/workspace-durable-object.ts").WorkspaceDurableObject
  >;
}

export const itxEnv = workerEnv as unknown as Env;
