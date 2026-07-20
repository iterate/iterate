import { env as workerEnv } from "cloudflare:workers";
import type { AuthWorker } from "@iterate-com/auth-contract/worker";
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
   * is where a dynamic isolate gets its scoped itx binding and egress
   * fetcher. */
  LOADER: WorkerLoader;
  /** Slug -> project id (+ metadata) cache in front of the auth worker's
   * project directory (project-directory.ts). */
  PROJECT_DIRECTORY: KVNamespace;
  /**
   * Auth's default Worker binding. Its project-directory and token-
   * introspection methods are private RPC capabilities; auth's public HTTP
   * `fetch` remains a separate surface. Possession of this required same-
   * account binding is the RPC credential; no auth service token is present
   * in OS runtime configuration.
   */
  AUTH: Service<AuthWorker>;
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
   * The typechecker sidecar (src/typechecker.ts): compiles virtual TypeScript
   * projects and returns diagnostics, behind provide-time capability-types
   * validation and `itx.docs.typecheck`. The only script carrying the
   * TypeScript compiler (tswasm, ~30MB wasm) quarantined out of the product
   * script.
   */
  TYPECHECKER: Service<
    import("./domains/typecheck/typechecker-entrypoint.ts").TypecheckerEntrypoint
  >;

  AGENT: DurableObjectNamespace<
    import("./domains/agents/agent-durable-object.ts").AgentDurableObject
  >;
  AGENT_COLLECTION: DurableObjectNamespace<
    import("./domains/agents/agent-collection-durable-object.ts").AgentCollectionDurableObject
  >;
  CAPABILITY_HOST: DurableObjectNamespace<
    import("./domains/capability-host/capability-host-durable-object.ts").CapabilityHostDurableObject
  >;
  DEVICE: DurableObjectNamespace<
    import("./domains/devices/device-durable-object.ts").DeviceDurableObject
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
   * Deploy identity (wrangler `version_metadata` binding). The stream
   * processor hosts' crash-loop breaker keys its backoff budget on the version
   * id so a fresh deploy — the usual antidote to a deterministic crash loop —
   * retries immediately instead of waiting out the plateau. Optional because
   * local dev may not provide it; read through {@link workerVersion}.
   */
  CF_VERSION_METADATA?: { id: string; tag?: string };
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
  WORKSPACE_V2: DurableObjectNamespace<
    import("./domains/workspaces/workspace-durable-object.ts").WorkspaceV2DurableObject
  >;
}

export const itxEnv = workerEnv as unknown as Env;

/** The deploy's version id, for the processor hosts' crash-loop breaker.
 * "unversioned" in environments without the version_metadata binding. */
export function workerVersion(env: Env): string {
  return env.CF_VERSION_METADATA?.id ?? "unversioned";
}
