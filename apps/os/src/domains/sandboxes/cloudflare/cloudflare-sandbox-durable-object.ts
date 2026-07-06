import type { OutboundHandler } from "@cloudflare/containers";
import { Sandbox, type DirectoryBackup } from "@cloudflare/sandbox";
import type { Env } from "../../../env.ts";
import { DurableObjectNameCodec } from "../../durable-object-names.ts";
import { projectStub } from "../../projects/egress.ts";
import { PROJECT_REPO_PATH } from "../../repos/utils.ts";
import { normalizeSandboxPath } from "../utils.ts";

/**
 * The workspace root inside every sandbox container: what the backup/restore
 * cycle persists (see {@link CloudflareSandboxDurableObject}). Everything under
 * it survives idle sleep via the R2 backup; nothing outside it does — container
 * disk is ephemeral.
 */
const SANDBOX_WORKSPACE_DIR = "/workspace";

/** Where the project repo is checked out, inside the persisted workspace. */
const SANDBOX_PROJECT_REPO_DIR = `${SANDBOX_WORKSPACE_DIR}/repo`;

/**
 * How long a sandbox's workspace backup survives without the sandbox waking
 * again (the SDK GCs backups after their ttl). 90 days: long enough that any
 * plausibly-still-wanted workspace comes back intact, short enough that the
 * churn of short-lived sandboxes (e2e runs a fresh project per test) does not
 * accumulate in R2 forever. Durable work belongs in the repo (committed and
 * pushed); the workspace backup is for everything in flight around it.
 */
const SANDBOX_BACKUP_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Durable pointer to the newest good workspace backup (a DirectoryBackup). */
const BACKUP_HANDLE_STORAGE_KEY = "iterate-sandbox-workspace-backup";

// The container-outbound handler runs in the ContainerProxy WorkerEntrypoint,
// not on a sandbox instance, so it only gets the container's opaque Durable
// Object id — not the project it belongs to. This isolate-local cache turns
// that id into a projectId with at most one lookup per sandbox per isolate;
// the lookup itself dials the sandbox for its durable identity.
const projectIdByContainerId = new Map<string, string>();

async function resolveEgressProjectId(env: Env, containerId: string): Promise<string> {
  const cached = projectIdByContainerId.get(containerId);
  if (cached !== undefined) return cached;
  const stub = env.SANDBOX.get(env.SANDBOX.idFromString(containerId));
  const projectId = await stub.egressProjectId();
  projectIdByContainerId.set(containerId, projectId);
  return projectId;
}

/**
 * The sandbox's own address, as carried by its Durable Object name:
 * which project it belongs to and its path (an agent's own path for agent
 * sandboxes, `/sandboxes/cloudflare/...` for standalone ones).
 */
type SandboxIdentity = { path: string; projectId: string };

const IDENTITY_STORAGE_KEY = "iterate-sandbox-identity";

/**
 * A project-scoped Cloudflare Sandbox: the `@cloudflare/sandbox` container
 * Durable Object, addressed like every other domain object
 * (`{projectId}.iterate{path}` in the SANDBOX namespace). The public surface
 * IS the SDK's — `itx.sandboxes.get(path)` returns this object's bare RPC stub
 * (exec, files, processes, ports, gitCheckout, …) with nothing wrapped on top.
 *
 * Lifecycle is the SDK's: getting the stub is cheap (no container), the first
 * command boots the container, and the SDK's durable `sleepAfter` idle alarm
 * (3m, see below) stops it again. Identity and Durable Object storage survive
 * sleep. The container's own disk does NOT — but `/workspace` comes back,
 * because going to sleep snapshots it to R2 and the next start restores it
 * (see behavior 1). Lifecycle transitions are also appended as events to the
 * stream at this sandbox's own path — for an agent's sandbox that is the
 * agent's own journal (see `#emitLifecycleEvent`).
 *
 * Three behaviors are added over the stock SDK class:
 *
 * 1. `/workspace` PERSISTS ACROSS SLEEP. Container disk is ephemeral —
 *    Cloudflare offers no persistent volume
 *    (https://developers.cloudflare.com/containers/faq/) — so this class uses
 *    the Sandbox SDK's backup/restore
 *    (https://developers.cloudflare.com/sandbox/guides/backup-restore/):
 *    `onActivityExpired` (the idle-timer hook, the one moment the container is
 *    still running but about to stop) snapshots `/workspace` to the env's
 *    {@link Env.BACKUP_BUCKET} R2 bucket, and the next `onStart` restores the
 *    newest snapshot before falling back to a fresh repo clone. Snapshots are
 *    gitignore-aware (no node_modules etc.), so they stay small and restore
 *    fast (~seconds, vs a cold clone).
 *
 *    Known window: this is snapshot-granular. A container that CRASHES (rather
 *    than idling out) loses whatever changed since the last snapshot — durable
 *    work belongs in the repo, committed and pushed.
 *
 *    Alternatives Cloudflare documents, and why not:
 *    - `mountBucket` (https://developers.cloudflare.com/sandbox/api/storage/)
 *      mounts R2 as a live FUSE filesystem — continuous persistence, tried
 *      first. Its R2-binding mode routes s3fs traffic to the magic host
 *      `r2.internal`, serviced by the SDK's own per-host container-egress
 *      interceptor — which our catch-all `outbound` handler (behavior 3)
 *      necessarily swallows, and the two cannot compose without exempting
 *      storage traffic from project egress policy. Verified broken on a real
 *      preview (every filesystem op → I/O error). Backup/restore has no such
 *      conflict: its transfers are plain HTTPS to the real
 *      `*.r2.cloudflarestorage.com` host via presigned URLs, which flow
 *      THROUGH project egress like any other request.
 *    - A raw R2 FUSE mount hand-rolled in the Dockerfile
 *      (https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)
 *      is the same mechanism as `mountBucket`, minus the management — same
 *      conflict.
 *    - Durable Object storage (`ctx.storage`) is key/value, not a filesystem —
 *      right for identity and the backup handle (as used here), not a repo
 *      checkout.
 *
 * 2. The project repo is ALWAYS checked out at {@link SANDBOX_PROJECT_REPO_DIR}.
 *    Every container start provisions the workspace — restore the last
 *    snapshot if one exists, then clone the repo if the checkout is still
 *    missing — and `ensureProjectRepo()` is the awaitable guarantee for
 *    repo-dependent work.
 *
 * 3. ALL container egress is routed through the project's egress decision
 *    point, exactly like a dynamic worker's `globalOutbound` — see the
 *    `outbound` handler below. `interceptHttps` extends that to HTTPS by
 *    man-in-the-middling TLS with the Cloudflare-provided container CA (the
 *    stock `@cloudflare/sandbox` image installs it at start when
 *    `SANDBOX_INTERCEPT_HTTPS` is set, which the SDK sets from this flag), so a
 *    sandbox cannot reach the internet except through project policy.
 */
export class CloudflareSandboxDurableObject extends Sandbox<Env> {
  // Intercept HTTPS as well as HTTP: without this, only plaintext egress would
  // reach the `outbound` handler and TLS traffic would bypass project policy.
  override interceptHttps = true;

  /**
   * The catch-all container-egress handler: EVERY outbound request a sandbox
   * container makes (HTTP and, via `interceptHttps`, HTTPS) arrives here and is
   * forwarded to the owning project's Durable Object — the same decision point
   * `ProjectEgressEntrypoint` gives dynamic workers. There is no direct
   * internet path: a sandbox reaches the outside world only through project
   * egress policy. Runs in the ContainerProxy WorkerEntrypoint (no sandbox
   * `this`), so the project is recovered from the container id.
   *
   * Registered in a static BLOCK, not as `static outbound = …`. `outbound` is
   * a static accessor on the base `Container` class whose setter registers the
   * handler in the container-proxy's outbound registry. Under
   * `useDefineForClassFields` (our ES2024 target) a `static` field would
   * DEFINE an own data property that shadows that accessor — the setter never
   * runs, nothing registers, and every request silently falls through to a
   * direct `fetch` (TLS still MITM'd, but egress bypasses project policy). An
   * assignment invokes the inherited setter, so the registry is populated.
   */
  static {
    const outbound: OutboundHandler<Env> = async (request, env, ctx) => {
      const projectId = await resolveEgressProjectId(env, ctx.containerId);
      return projectStub(env.PROJECT, projectId).fetch(request);
    };
    this.outbound = outbound;
  }

  /**
   * This sandbox's project, for the egress handler above. A plain read of the
   * durable identity — the handler cannot see the Durable Object name, only the
   * id, so it asks the instance who it belongs to.
   */
  async egressProjectId(): Promise<string> {
    return this.#identity().projectId;
  }

  /**
   * Idle containers hold an instance slot until this expires, and the app's
   * container namespace caps concurrent instances (maxInstances in
   * alchemy.run.ts). With the SDK default of 10m, e2e churn (a fresh project +
   * sandbox per test) exhausted the cap in minutes and every later sandbox
   * start wedged until an old container timed out. 3m keeps interactive
   * sessions warm across a pause while reclaiming capacity ~3x faster; a
   * restart after idle costs one container cold boot + repo clone.
   */
  override sleepAfter = "3m";

  /**
   * Record who this sandbox is before any other traffic reaches it.
   *
   * Identity normally derives from the Durable Object name, but container
   * runtimes do not reliably surface `ctx.id.name` (the local dev runtime
   * drops it) — the `@cloudflare/sandbox` SDK pushes its name in through
   * `getSandbox()` for the same reason. The sandbox collection awaits this
   * before handing out the stub, and the value is durable, so the identity is
   * always in place by the time a container start needs it.
   *
   * Identity is WRITE-ONCE. The stub `get()` returns is the bare Durable
   * Object surface, so this method is callable by anyone holding a sandbox —
   * if it re-wrote storage, a caller could point an already-named sandbox at
   * a different project and the next repo clone would embed THAT project's
   * write token. The first write comes from the collection, which derived the
   * identity from the caller's authority; everything after must match it (and
   * must match `ctx.id.name` whenever the runtime provides it).
   */
  async ensureIdentity(identity: SandboxIdentity): Promise<void> {
    const path = normalizeSandboxPath(identity.path);
    const expectedName = DurableObjectNameCodec.stringify({
      projectId: identity.projectId,
      path,
    });
    if (this.ctx.id.name !== undefined && this.ctx.id.name !== expectedName) {
      throw new Error(
        `sandbox identity mismatch: durable object is named "${this.ctx.id.name}", got "${expectedName}"`,
      );
    }
    const stored = this.ctx.storage.kv.get<SandboxIdentity>(IDENTITY_STORAGE_KEY);
    if (stored !== undefined) {
      if (stored.projectId !== identity.projectId || stored.path !== path) {
        throw new Error(
          `sandbox identity mismatch: this sandbox is "${stored.projectId}:${stored.path}", got "${identity.projectId}:${path}"`,
        );
      }
      return;
    }
    this.ctx.storage.kv.put(IDENTITY_STORAGE_KEY, { path, projectId: identity.projectId });
  }

  #identity(): SandboxIdentity {
    const name = this.ctx.id.name;
    if (name !== undefined) {
      const parsed = DurableObjectNameCodec.parse(name);
      return { path: normalizeSandboxPath(parsed.path), projectId: parsed.projectId };
    }
    const stored = this.ctx.storage.kv.get<SandboxIdentity>(IDENTITY_STORAGE_KEY);
    if (!stored) {
      throw new Error(
        "sandbox has no identity yet — reach it through itx.sandboxes.get(path), not a raw stub",
      );
    }
    return stored;
  }

  #workspaceReady: Promise<void> | undefined;
  // Whether the CURRENT container's workspace was fully provisioned (restored
  // or cloned). Gates the idle-time backup: snapshotting a half-provisioned
  // workspace would overwrite the pointer to the last GOOD backup.
  #workspaceProvisioned = false;

  override async onStart(): Promise<void> {
    await super.onStart();
    this.#emitLifecycleEvent("container-started");
    // Provision the workspace — restore the last backup, clone the repo if the
    // checkout is still missing — in the BACKGROUND. It cannot run inside
    // `onStart` itself: `onStart` executes in the container framework's
    // blockConcurrencyWhile, which has a hard ~30s budget and resets the
    // Durable Object on overrun (verified live), and a cold clone or a large
    // restore can exceed it — and timer events are input-gated in here, so the
    // work cannot even bound itself with a deadline. Callers that need the
    // workspace await `ensureProjectRepo()`.
    //
    // Each start is a fresh container process (empty disk), so a readiness
    // promise from a previous container must not satisfy this one.
    this.#workspaceReady = undefined;
    this.#workspaceProvisioned = false;
    this.ctx.waitUntil(
      this.#ensureWorkspace().catch((error: unknown) =>
        console.error("sandbox workspace setup failed", error),
      ),
    );
  }

  /**
   * The idle-timer hook: fires when `sleepAfter` expires and the container is
   * STILL RUNNING — the one moment a pre-sleep snapshot is possible (`onStop`
   * is too late: the container is already gone, and the hook can even fire on
   * a later wake). Snapshot `/workspace`, then let the SDK stop the container.
   *
   * A backup failure must never wedge the container awake — the container
   * holds an instance slot against the namespace cap — so failures are logged
   * and emitted as events, and the stop proceeds regardless; the durable
   * handle still points at the last good backup.
   */
  override async onActivityExpired(): Promise<void> {
    try {
      await this.#backupWorkspace();
    } catch (error) {
      console.error("sandbox workspace backup failed", error);
      this.#emitLifecycleEvent("backup-failed", { error: String(error) });
    }
    await super.onActivityExpired();
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    // May fire late: if the Durable Object was hibernated when the container
    // exited, the SDK delivers this on the next wake.
    this.#emitLifecycleEvent("container-stopped");
  }

  /**
   * Snapshot `/workspace` to R2 and move the durable handle to the new backup.
   * Gitignore-aware and node_modules-free, so archives stay small and restores
   * fast; reinstalling dependencies is the restored workspace's job. The
   * handle is only overwritten AFTER `createBackup` succeeds, so a failed
   * backup can never orphan the previous good snapshot.
   *
   * Transfer mode is chosen by what the env provides: with R2 S3 credentials
   * the SDK presigns `*.r2.cloudflarestorage.com` URLs and the container
   * transfers directly (fast, and through project egress like all container
   * traffic); without them — local dev always, a deployed env until keys are
   * minted — archives stream through the Durable Object's BACKUP_BUCKET
   * binding (the SDK's `localBucket` mode: slower, but zero-config and the
   * only mode `wrangler dev` supports).
   */
  async #backupWorkspace(): Promise<void> {
    if (!this.#workspaceProvisioned) return;
    const { projectId, path } = this.#identity();
    const backup = await this.createBackup({
      dir: SANDBOX_WORKSPACE_DIR,
      name: `${projectId}${path}`,
      ttl: SANDBOX_BACKUP_TTL_SECONDS,
      gitignore: true,
      excludes: ["node_modules"],
      ...(this.#canPresignBackupTransfers() ? {} : { localBucket: true }),
    });
    this.ctx.storage.kv.put(BACKUP_HANDLE_STORAGE_KEY, backup);
    this.#emitLifecycleEvent("backup-created", { backupId: backup.id });
  }

  #canPresignBackupTransfers(): boolean {
    return Boolean(
      this.env.R2_ACCESS_KEY_ID &&
      this.env.R2_SECRET_ACCESS_KEY &&
      this.env.CLOUDFLARE_R2_ACCOUNT_ID,
    );
  }

  /**
   * Restore the newest workspace backup into the fresh container, if one
   * exists. Returns whether `/workspace` now holds a restored snapshot; any
   * failure (expired ttl, deleted object, transfer error) degrades to `false`
   * so provisioning falls back to a clean clone rather than failing the start.
   */
  async #restoreWorkspace(): Promise<boolean> {
    const backup = this.ctx.storage.kv.get<DirectoryBackup>(BACKUP_HANDLE_STORAGE_KEY);
    if (backup === undefined) return false;
    try {
      const result = await this.restoreBackup(backup);
      if (!result.success) return false;
      this.#emitLifecycleEvent("workspace-restored", { backupId: backup.id });
      return true;
    } catch (error) {
      console.warn("sandbox workspace restore failed, falling back to clone", error);
      return false;
    }
  }

  /**
   * The workspace guarantee, awaitable: resolves once `/workspace` is
   * provisioned for the CURRENT container — the last backup restored (fast)
   * and `/workspace/repo` holding a completed checkout (cloned fresh when the
   * backup lacked one or there was no backup). Idempotent and safe to call any
   * time — provisioning starts automatically on every container start, so this
   * usually returns quickly; await it before work that depends on the repo.
   *
   * Named `ensureProjectRepo` for its callers — the repo is the thing they
   * wait on — but it guarantees the whole workspace.
   */
  async ensureProjectRepo(): Promise<void> {
    // A container restart mid-await resets `#workspaceReady` (fresh disk), so
    // a promise that completed against the PREVIOUS container must not satisfy
    // this call — loop until the run we awaited is still current.
    while (true) {
      const run = this.#ensureWorkspace();
      await run;
      if (this.#workspaceReady === run) return;
    }
  }

  #ensureWorkspace(): Promise<void> {
    this.#workspaceReady ??= (async () => {
      const restored = await this.#restoreWorkspace();
      // Clone when the restore didn't produce a checkout (no backup yet, the
      // backup expired, or it somehow predates the repo). #cloneProjectRepo
      // probes the marker itself, so a restored checkout makes this a no-op.
      await this.#cloneProjectRepo();
      if (!restored) this.#emitLifecycleEvent("workspace-cloned");
      this.#workspaceProvisioned = true;
    })().catch((error: unknown) => {
      // Let the next ensure retry instead of caching the failure forever.
      this.#workspaceReady = undefined;
      throw error;
    });
    return this.#workspaceReady;
  }

  /**
   * Append a lifecycle event to the stream at this sandbox's own path — for an
   * agent's sandbox that is the agent's own journal, so the agent (and anyone
   * tailing the stream) sees container starts/stops, snapshots, and restores
   * as ordinary history. Best-effort by design: lifecycle telemetry must never
   * block or fail container start/stop, so errors are logged and dropped.
   */
  #emitLifecycleEvent(kind: string, payload: Record<string, unknown> = {}): void {
    try {
      const { projectId, path } = this.#identity();
      const stream = this.env.STREAM.getByName(
        DurableObjectNameCodec.stringify({ projectId, path }),
      );
      this.ctx.waitUntil(
        Promise.resolve(
          stream.append({
            type: `events.iterate.com/sandbox/${kind}`,
            payload,
          }),
        ).catch((error: unknown) =>
          console.warn(`sandbox lifecycle event append failed (${kind})`, error),
        ),
      );
    } catch (error) {
      console.warn(`sandbox lifecycle event skipped (${kind})`, error);
    }
  }

  async #cloneProjectRepo(): Promise<void> {
    // Probe a marker only a completed clone has — a bare directory check
    // would treat the debris of an interrupted checkout as done and leave
    // the sandbox without the repo until the container is replaced.
    const existing = await this.exists(`${SANDBOX_PROJECT_REPO_DIR}/.git/HEAD`);
    if (existing.exists) return;

    const repo = this.env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#identity().projectId,
        path: PROJECT_REPO_PATH,
      }),
    );
    const access = await repo.gitAccess();
    // Same credential shape the Repo Durable Object uses for its own clones
    // (username "x", artifact write token as password). Embedding them in the
    // remote keeps `git pull`/`git push` working inside the sandbox.
    const remote = new URL(access.remote);
    remote.username = "x";
    remote.password = access.token;

    // The Artifacts git endpoint intermittently returns 503 on a cold repo
    // (observed in preview e2e: "Failed to clone repository ... error: 503").
    // A clone into a fresh directory is idempotent, so retry with a short
    // backoff instead of failing the sandbox start on one bad response.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.exec(`rm -rf ${SANDBOX_PROJECT_REPO_DIR}`);
      try {
        const result = await this.gitCheckout(remote.toString(), {
          branch: access.defaultBranch,
          targetDir: SANDBOX_PROJECT_REPO_DIR,
        });
        if (result.success) return;
        lastError = new Error(
          `cloning the project repo into ${SANDBOX_PROJECT_REPO_DIR} failed (exit ${result.exitCode})`,
        );
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) {
        console.warn(`sandbox project repo clone attempt ${attempt} failed, retrying:`, lastError);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
    throw lastError;
  }
}
