import type { OutboundHandler } from "@cloudflare/containers";
import { Sandbox, type DirectoryBackup } from "@cloudflare/sandbox";
import type { Env } from "../../../env.ts";
import { DurableObjectNameCodec } from "../../durable-object-names.ts";
import { projectStub } from "../../projects/egress.ts";
import { PROJECT_REPO_PATH } from "../../repos/utils.ts";
import {
  SandboxProcessorContract,
  type SandboxLifecycleEventInput,
} from "../sandbox-processor-contract.ts";
import { normalizeSandboxPath } from "../utils.ts";

/**
 * The workspace root inside every sandbox container: what the backup/restore
 * cycle persists (see {@link CloudflareSandboxDurableObject}). Everything under
 * it survives idle sleep via the R2 backup; nothing outside it does — container
 * disk is ephemeral.
 */
const SANDBOX_WORKSPACE_DIR = "/workspace";

/**
 * Where the project repo is checked out, inside the persisted workspace, and
 * the default working directory of every command that doesn't choose its own
 * `cwd`. The plural `repos/` segment leaves room for additional checkouts
 * beside the project's own.
 */
const SANDBOX_PROJECT_REPO_DIR = `${SANDBOX_WORKSPACE_DIR}/repos/project`;

/**
 * The platform repo baked into the image with `pnpm install` already run.
 * It lives outside `/workspace` because workspace restore overlays that tree
 * and backups intentionally exclude node_modules. A symlink exposes it at the
 * conventional workspace repo path after every restore/start.
 */
const BAKED_ITERATE_REPO_SOURCE_DIR = "/opt/iterate/iterate";
const BAKED_ITERATE_REPO_WORKSPACE_DIR = `${SANDBOX_WORKSPACE_DIR}/repos/github.com/iterate/iterate`;

/**
 * The sandbox warm-up script, baked into the image (see
 * `apps/os/sandbox/warmup.sh` and the `COPY` in `apps/os/sandbox/Dockerfile`).
 * The Durable Object runs it on the container during provisioning, in the
 * background, to get the baked coding tools logged in and ready (e.g. Codex).
 * Keeping the steps in a reviewable shell asset — rather than command strings
 * spread through this class — is what lets the whole start → restore/clone →
 * warm-up saga read as one thing and stay easy to extend.
 */
const SANDBOX_WARMUP_SCRIPT_PATH = "/opt/iterate/warmup.sh";

/**
 * How long a sandbox's workspace backup survives without the sandbox waking
 * again (the SDK GCs backups after their ttl). 90 days: long enough that any
 * plausibly-still-wanted workspace comes back intact, short enough that the
 * churn of short-lived sandboxes (e2e runs a fresh project per test) does not
 * accumulate in R2 forever. Durable work belongs in the repo (committed and
 * pushed); the workspace backup is for everything in flight around it.
 */
const SANDBOX_BACKUP_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Durable pointer to the newest good workspace backup (a DirectoryBackup).
 *
 * The `-v2` suffix abandons any backup taken under the previous workspace
 * layout, where the repo lived at `/workspace/repo` instead of
 * {@link SANDBOX_PROJECT_REPO_DIR}. Restoring such a snapshot would leave the
 * old checkout at the old path while provisioning cloned a fresh one at the
 * new path — a confusing dual tree whose restored (uncommitted) work the
 * default cwd would ignore. Dropping the old handle instead makes the first
 * start after this change do one clean clone at the new path; the orphaned R2
 * objects GC on their ttl. Safe because a workspace backup is in-flight
 * scratch — durable work lives in the repo, committed and pushed.
 */
const BACKUP_HANDLE_STORAGE_KEY = "iterate-sandbox-workspace-backup-v2";

/**
 * Durable env-var map for the sandbox (see {@link CloudflareSandboxDurableObject}).
 * A `Record<string,string>` applied to every command in the container;
 * conventionally ALL_CAPS keys whose values are `getSecret({ path })`
 * placeholders — so the material stays in the secret system and is injected
 * only at egress, never entering the container.
 */
const SANDBOX_ENV_STORAGE_KEY = "iterate-sandbox-env";
type SandboxEnvVars = Record<string, string>;

/**
 * Env vars every sandbox gets by default so a coding agent works out of the
 * box: the provider keys the baked CLIs read, pointed at conventional project
 * secret paths as `getSecret(...)` placeholders (substituted only at egress).
 * A project that seeds a key at one of these paths lets its agents code
 * immediately; if the path has no secret, the var is harmless until used (the
 * egress substitution then fails loudly). `configureEnvVars` overrides any of
 * these per sandbox.
 */
const DEFAULT_SANDBOX_ENV: SandboxEnvVars = {
  OPENAI_API_KEY: 'getSecret({ path: "/secrets/openai-api-key" })',
  ANTHROPIC_API_KEY: 'getSecret({ path: "/secrets/anthropic-api-key" })',
};

// The two `readFile` result types (`ReadFileResult`, and the `encoding: "none"`
// stream result) are not exported by the SDK, so recover them from the
// overloaded base signature rather than mirroring the interfaces (which would
// drift). `ReturnType` collapses to the last overload, so match BOTH call
// signatures in one conditional and `infer` each return — this is what lets the
// override below restate the overloads with the SDK's exact types.
type ReadFileReturns = Sandbox<Env>["readFile"] extends {
  (path: string, options: { encoding: "none"; sessionId?: string }): infer Stream;
  (
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64"; sessionId?: string },
  ): infer Buffered;
}
  ? { stream: Stream; buffered: Buffered }
  : never;

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
 * 2. The project repo is ALWAYS checked out at {@link SANDBOX_PROJECT_REPO_DIR},
 *    UNCONDITIONALLY: every public command and file operation is guarded by
 *    `ensureProjectRepo()` (see the overrides), so the first thing any caller
 *    can do already sees a provisioned workspace — restored from the last
 *    snapshot, with the repo cloned fresh when the snapshot lacked it.
 *    Commands also default their `cwd` to the repo checkout, so a bare
 *    `exec("ls")` lists the project.
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

  // Tag every instance for the Containers dashboard/analytics, so sandbox
  // instances are filterable apart from any other container class in the
  // account. Static (app/component); per-sandbox identity already lives in the
  // Durable Object name and the lifecycle stream. See docs/cloudflare-sandboxes.md.
  override labels = { app: "iterate-os", component: "sandbox" };

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
   * container namespace caps concurrent instances (max_instances in
   * scripts/generate-wrangler-config.ts). With the SDK default of 10m, e2e
   * churn (a fresh project +
   * sandbox per test) exhausted the cap in minutes and every later sandbox
   * start wedged until an old container timed out. 3m keeps interactive
   * sessions warm across a pause while reclaiming capacity ~3x faster; a
   * restart after idle costs one container cold boot + repo clone.
   */
  override sleepAfter = "3m";

  /**
   * Idle expiry: SNAPSHOT `/workspace`, then DESTROY the container.
   *
   * This is the one moment a pre-sleep snapshot is possible — the idle timer
   * fired but the container is STILL RUNNING (`onStop` is too late: the
   * container is already gone, and that hook can even fire on a later wake).
   * A backup failure must never wedge the container alive — it holds an
   * instance slot against the namespace cap — so failures are logged and
   * emitted as events, and the teardown proceeds regardless; the durable
   * handle still points at the last good backup.
   *
   * DESTROY, not the SDK's stop (SIGTERM): a stopped container keeps its
   * instance ASSIGNED to this Durable Object, and assignments count against
   * the app's max_instances and never expire on their own
   * (`wrangler containers info` on a slot mid-marathon: active 0, assigned 99
   * — including day-old idle slots still holding their last run's
   * assignments; only destroy or an app rollout releases them). Every e2e
   * fixture creates a fresh sandbox DO, so stop-on-idle leaks ~7-8
   * assignments per preview e2e run and the cap wedges every new sandbox
   * start after ~a dozen runs — the real mechanism behind the recurring
   * "Container is starting/provisioning" windows
   * (docs/preview-e2e-flake-hunt.md flake 23, superseding the flake 19/20
   * theories). Destroy costs nothing BECAUSE of the snapshot above: the next
   * wake restores `/workspace` from it, so destroy-then-wake and
   * stop-then-wake land in the same place (destroy leaves Durable Object
   * storage — the identity and backup handle — intact; the SDK's doDestroy
   * deletes only its own port/tunnel/runtime keys). The SDK's keepAlive guard
   * is preserved (its own override skips shutdown when a caller enabled
   * keepAlive; the field is private, hence the cast).
   */
  override async onActivityExpired(): Promise<void> {
    const keepAlive = (this as unknown as { keepAliveEnabled?: boolean }).keepAliveEnabled === true;
    if (keepAlive) {
      return super.onActivityExpired();
    }
    try {
      await this.#backupWorkspace();
    } catch (error) {
      console.error("sandbox workspace backup failed", error);
      this.#emitLifecycleEvent({
        type: "events.iterate.com/sandbox/backup-failed",
        payload: { error: String(error) },
      });
    }
    await this.destroy();
  }

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
  // Per-container memo for the background warm-up script (tool logins land on
  // the ephemeral container disk, so a fresh container re-runs it).
  #warmup: Promise<void> | undefined;

  override async onStart(): Promise<void> {
    await super.onStart();
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/container-started",
      payload: {},
    });
    // Each start is a fresh container process (empty disk), so a readiness
    // promise or provisioned flag from a previous container must not satisfy
    // this one. Provisioning itself is NOT kicked off here:
    //
    // - It cannot run inline — `onStart` executes in the container framework's
    //   blockConcurrencyWhile, which has a hard ~30s budget and resets the
    //   Durable Object on overrun (verified live), and a cold clone or a large
    //   restore can exceed it.
    // - A background kick would be redundant AND racy: every workspace-touching
    //   command is guarded by `ensureProjectRepo()` (see the overrides below),
    //   so nothing can observe the workspace before provisioning anyway — and
    //   when a guard's own restore is what booted this container, an eager
    //   kick here would spawn a SECOND provisioning run concurrent with the
    //   guard's in-flight one (two clones racing `rm -rf` in one directory).
    this.#workspaceReady = undefined;
    this.#workspaceProvisioned = false;
    // A fresh container has an empty disk (tool auth is gone), so warm-up must
    // run again — clear the per-container memo.
    this.#warmup = undefined;
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    // May fire late: if the Durable Object was hibernated when the container
    // exited, the SDK delivers this on the next wake.
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/container-stopped",
      payload: {},
    });
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
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/backup-created",
      payload: { backupId: backup.id },
    });
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
      this.#emitLifecycleEvent({
        type: "events.iterate.com/sandbox/workspace-restored",
        payload: { backupId: backup.id },
      });
      return true;
    } catch (error) {
      console.warn("sandbox workspace restore failed, falling back to clone", error);
      return false;
    }
  }

  /**
   * The workspace guarantee, awaitable: resolves once `/workspace` is
   * provisioned for the CURRENT container — the last backup restored (fast)
   * and {@link SANDBOX_PROJECT_REPO_DIR} holding a completed checkout (cloned
   * fresh when the backup lacked one or there was no backup). Idempotent and
   * safe to call any time. Callers rarely need it explicitly: every
   * workspace-touching command below is guarded by it, which is what makes
   * "the repo is ALWAYS checked out" unconditional rather than an etiquette.
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

  /**
   * Set environment variables for the sandbox — the durable `Record<string,
   * string>` applied to every command (`exec`, `startProcess`, …). Merges into
   * the stored map (pass a var with an empty string to clear it), so callers
   * build the environment incrementally.
   *
   * The intended value shape is a `getSecret({ path })` placeholder: the
   * material then stays in the secret system and is substituted only at egress
   * (the project egress path already does this for any header carrying the
   * placeholder), so a coding agent can read e.g. `ANTHROPIC_API_KEY` from the
   * environment and call the provider, yet the real key never enters the
   * container. Plain non-secret values are fine too. NEVER pass raw secret
   * material — it would sit in the container's environment and the container
   * filesystem's snapshots.
   *
   * Not guarded by `ensureProjectRepo()` (it's configuration, valid before the
   * container ever boots): the map is persisted now and re-applied during
   * provisioning; if a container is already running, the delta is applied to it
   * immediately. Emits a `sandbox/configured` event whose `env` records the
   * map set in this call (key → getSecret placeholder / literal) on the
   * sandbox's stream/journal — so never pass raw secret material as a value.
   */
  async configureEnvVars(vars: SandboxEnvVars): Promise<{ keys: string[] }> {
    const stored = this.ctx.storage.kv.get<SandboxEnvVars>(SANDBOX_ENV_STORAGE_KEY) ?? {};
    const merged = { ...stored, ...vars };
    this.ctx.storage.kv.put(SANDBOX_ENV_STORAGE_KEY, merged);
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/configured",
      payload: { env: vars },
    });
    // Apply the delta to a running container so an in-flight session picks it
    // up without a restart; if it isn't provisioned yet, provisioning applies
    // the full stored map. Best-effort — never fail configuration on a
    // transient container hiccup.
    if (this.#workspaceProvisioned) {
      await super
        .setEnvVars(vars)
        .catch((error: unknown) =>
          console.warn("sandbox configureEnvVars: applying to running container failed", error),
        );
    }
    return { keys: Object.keys(merged) };
  }

  async #applyStoredEnvVars(): Promise<void> {
    // Defaults first, explicit config last — so a project that seeds the
    // conventional provider secrets gets a code-ready sandbox with no setup,
    // while configureEnvVars still wins for anything it sets.
    const stored = this.ctx.storage.kv.get<SandboxEnvVars>(SANDBOX_ENV_STORAGE_KEY) ?? {};
    await super.setEnvVars({ ...DEFAULT_SANDBOX_ENV, ...stored });
  }

  /**
   * Run the baked warm-up script ({@link SANDBOX_WARMUP_SCRIPT_PATH}) so the
   * container's coding tools are ready to use out of the box — e.g. Codex 0.142
   * won't use the `OPENAI_API_KEY` env directly, it needs a one-time
   * `codex login --with-api-key`, which the script does. Kicked off in the
   * BACKGROUND during provisioning (overlapping the clone) and memoized per
   * container (tool auth is on the ephemeral disk). The script reads its keys
   * from the env, where they are getSecret placeholders substituted at egress,
   * so no material is handled here.
   *
   * Emits `sandbox/warmed-up` on success (so the whole start → restore/clone →
   * warm-up saga is visible on the sandbox's stream) or `sandbox/warmup-failed`
   * otherwise. Best-effort: a failure is logged and the memo cleared so a later
   * provision retries; the script itself keeps each step optional, so a missing
   * provider secret degrades to a tool that surfaces its own auth error on use,
   * not a failed warm-up.
   */
  #runWarmup(): Promise<void> {
    this.#warmup ??= (async () => {
      const result = await super.exec(`bash ${SANDBOX_WARMUP_SCRIPT_PATH}`);
      if (result.exitCode !== 0) {
        throw new Error(`sandbox warm-up failed (exit ${result.exitCode}): ${result.stderr}`);
      }
      this.#emitLifecycleEvent({
        type: "events.iterate.com/sandbox/warmed-up",
        payload: {},
      });
    })().catch((error: unknown) => {
      console.warn("sandbox warm-up failed", error);
      this.#emitLifecycleEvent({
        type: "events.iterate.com/sandbox/warmup-failed",
        payload: { error: String(error) },
      });
      this.#warmup = undefined; // let a later provision retry
    });
    return this.#warmup;
  }

  // ---------------------------------------------------------------------------
  // The workspace guarantee, enforced: every public command and file operation
  // below awaits `ensureProjectRepo()` before touching the container, so no
  // caller can ever observe `/workspace` without the project repo checked out
  // at SANDBOX_PROJECT_REPO_DIR — the guarantee is unconditional, not an
  // "await ensureProjectRepo() first" etiquette. This also closes an integrity
  // window: a write landing before the snapshot restore would be silently
  // clobbered BY the restore.
  //
  // Command runners additionally default `cwd` to the repo checkout, so a bare
  // `exec("ls")` operates on the project like a developer's shell would; an
  // explicit `cwd` always wins.
  //
  // Notes for maintainers:
  // - These are real prototype methods, not `field = () => …` — instance
  //   fields are invisible over workers RPC, and callers hold this class's
  //   bare stub.
  // - Provisioning itself must call `super.*` (it runs INSIDE the guard;
  //   `this.*` would deadlock on its own promise). The SDK's backup/restore
  //   internals use their own private exec paths and are unaffected.
  // - Session objects are covered via guarded `createSession`; the SDK's
  //   session wrappers route their file ops back through these methods.
  // - New SDK methods start unguarded — add workspace-touching ones here.
  // ---------------------------------------------------------------------------

  override async exec(...args: Parameters<Sandbox<Env>["exec"]>) {
    await this.ensureProjectRepo();
    const [command, options] = args;
    return super.exec(command, { cwd: SANDBOX_PROJECT_REPO_DIR, ...options });
  }

  override async execStream(...args: Parameters<Sandbox<Env>["execStream"]>) {
    await this.ensureProjectRepo();
    const [command, options] = args;
    return super.execStream(command, { cwd: SANDBOX_PROJECT_REPO_DIR, ...options });
  }

  override async startProcess(...args: Parameters<Sandbox<Env>["startProcess"]>) {
    await this.ensureProjectRepo();
    const [command, options, sessionId] = args;
    return super.startProcess(command, { cwd: SANDBOX_PROJECT_REPO_DIR, ...options }, sessionId);
  }

  override async createSession(...args: Parameters<Sandbox<Env>["createSession"]>) {
    await this.ensureProjectRepo();
    const [options] = args;
    return super.createSession({ cwd: SANDBOX_PROJECT_REPO_DIR, ...options });
  }

  override async runCode(...args: Parameters<Sandbox<Env>["runCode"]>) {
    await this.ensureProjectRepo();
    return super.runCode(...args);
  }

  override async runCodeStream(...args: Parameters<Sandbox<Env>["runCodeStream"]>) {
    await this.ensureProjectRepo();
    return super.runCodeStream(...args);
  }

  override async gitCheckout(...args: Parameters<Sandbox<Env>["gitCheckout"]>) {
    await this.ensureProjectRepo();
    return super.gitCheckout(...args);
  }

  override async mkdir(...args: Parameters<Sandbox<Env>["mkdir"]>) {
    await this.ensureProjectRepo();
    return super.mkdir(...args);
  }

  override async writeFile(...args: Parameters<Sandbox<Env>["writeFile"]>) {
    await this.ensureProjectRepo();
    return super.writeFile(...args);
  }

  override async deleteFile(...args: Parameters<Sandbox<Env>["deleteFile"]>) {
    await this.ensureProjectRepo();
    return super.deleteFile(...args);
  }

  override async renameFile(...args: Parameters<Sandbox<Env>["renameFile"]>) {
    await this.ensureProjectRepo();
    return super.renameFile(...args);
  }

  override async moveFile(...args: Parameters<Sandbox<Env>["moveFile"]>) {
    await this.ensureProjectRepo();
    return super.moveFile(...args);
  }

  // `readFile` is overloaded (encoding "none" returns a stream result vs the
  // default read result), and neither result type is exported. Restate both
  // overloads with return types recovered from the base's own signature (via
  // {@link ReadFileReturn}) — no mirrored interfaces to drift, still a
  // prototype method (a `field = () => …` would be invisible over RPC).
  override readFile(
    path: string,
    options: { encoding: "none"; sessionId?: string },
  ): ReadFileReturns["stream"];
  override readFile(
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64"; sessionId?: string },
  ): ReadFileReturns["buffered"];
  // Permissive implementation signature (hidden from callers — the two typed
  // overloads above are the public contract); the standard shape for
  // implementing an overloaded method.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded impl signature
  override async readFile(path: string, options?: any): Promise<any> {
    await this.ensureProjectRepo();
    return super.readFile(path, options);
  }

  override async readFileStream(...args: Parameters<Sandbox<Env>["readFileStream"]>) {
    await this.ensureProjectRepo();
    return super.readFileStream(...args);
  }

  override async listFiles(...args: Parameters<Sandbox<Env>["listFiles"]>) {
    await this.ensureProjectRepo();
    return super.listFiles(...args);
  }

  override async exists(...args: Parameters<Sandbox<Env>["exists"]>) {
    await this.ensureProjectRepo();
    return super.exists(...args);
  }

  override async watch(...args: Parameters<Sandbox<Env>["watch"]>) {
    await this.ensureProjectRepo();
    return super.watch(...args);
  }

  override async checkChanges(...args: Parameters<Sandbox<Env>["checkChanges"]>) {
    await this.ensureProjectRepo();
    return super.checkChanges(...args);
  }

  #ensureWorkspace(): Promise<void> {
    if (this.#workspaceReady !== undefined) return this.#workspaceReady;
    // `run` is only read inside the closures below, which execute strictly
    // after the assignment at the bottom (the first read sits behind two
    // awaits) — initialized to undefined so TS's definite-assignment analysis
    // doesn't have to prove that ordering.
    let run: Promise<void> | undefined = undefined;
    run = (async () => {
      const restored = await this.#restoreWorkspace();
      // Re-apply the durable env map onto THIS container (the SDK does not
      // document env persistence across restart), so every guarded command
      // below runs with the configured vars. Done BEFORE the clone so the
      // background Codex login (which reads the env) can overlap it.
      await this.#applyStoredEnvVars();
      // Run the warm-up script in the BACKGROUND — it reads the env placeholders
      // (substituted at egress) to log the baked tools in, so they just work
      // without any per-command login line. Kicked off here so it overlaps the
      // (slower) clone and is ready by the time the workspace is; it emits
      // sandbox/warmed-up and its failures are self-contained (see the method).
      this.ctx.waitUntil(this.#runWarmup());
      // Clone when the restore didn't produce a checkout (no backup yet, the
      // backup expired, or it somehow predates the repo). #cloneProjectRepo
      // probes the marker itself, so a restored checkout makes this a no-op.
      await this.#cloneProjectRepo();
      await this.#ensureBakedIterateRepoLink();
      // A container restart mid-run reset the state for a NEW, empty disk —
      // everything this run did landed on the old one. Only the still-current
      // run may mark the workspace provisioned: a stale run setting the flag
      // would let the idle backup snapshot a half-provisioned /workspace over
      // the last good backup.
      if (this.#workspaceReady !== run) return;
      if (!restored) {
        this.#emitLifecycleEvent({
          type: "events.iterate.com/sandbox/workspace-cloned",
          payload: {},
        });
      }
      this.#workspaceProvisioned = true;
    })().catch((error: unknown) => {
      console.error("sandbox workspace setup failed", error);
      this.#emitLifecycleEvent({
        type: "events.iterate.com/sandbox/workspace-setup-failed",
        payload: { error: String(error) },
      });
      // Let the next ensure retry instead of caching the failure forever —
      // but only clear OUR OWN registration; a stale failing run must not
      // clobber the promise of the newer run that replaced it.
      if (this.#workspaceReady === run) this.#workspaceReady = undefined;
      throw error;
    });
    this.#workspaceReady = run;
    return run;
  }

  /**
   * Append a lifecycle event to the stream at this sandbox's own path — for an
   * agent's sandbox that is the agent's own journal, so the agent (and anyone
   * tailing the stream) sees container starts/stops, snapshots, and restores
   * as ordinary history. The event catalog is the sandbox processor contract
   * (sandbox-processor-contract.ts); building through it keeps emission and
   * declaration from drifting. Best-effort by design: lifecycle telemetry must
   * never block or fail container start/stop, so errors are logged and
   * dropped.
   */
  #emitLifecycleEvent(input: SandboxLifecycleEventInput): void {
    try {
      const event = SandboxProcessorContract.buildEvent(input);
      const { projectId, path } = this.#identity();
      const stream = this.env.STREAM.getByName(
        DurableObjectNameCodec.stringify({ projectId, path }),
      );
      this.ctx.waitUntil(
        Promise.resolve(stream.append(event)).catch((error: unknown) =>
          console.warn(`sandbox lifecycle event append failed (${input.type})`, error),
        ),
      );
    } catch (error) {
      console.warn(`sandbox lifecycle event skipped (${input.type})`, error);
    }
  }

  // Provisioning calls the SDK through `super.*` throughout: the public
  // methods on THIS class are guarded by ensureProjectRepo() (see the
  // overrides above), and provisioning runs inside that guard — `this.*`
  // would deadlock on its own promise.
  async #cloneProjectRepo(): Promise<void> {
    // Probe a marker only a completed clone has — a bare directory check
    // would treat the debris of an interrupted checkout as done and leave
    // the sandbox without the repo until the container is replaced.
    const existing = await super.exists(`${SANDBOX_PROJECT_REPO_DIR}/.git/HEAD`);
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
      await super.exec(`rm -rf ${SANDBOX_PROJECT_REPO_DIR}`);
      try {
        const result = await super.gitCheckout(remote.toString(), {
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

  async #ensureBakedIterateRepoLink(): Promise<void> {
    const bakedRepo = await super.exists(`${BAKED_ITERATE_REPO_SOURCE_DIR}/pnpm-lock.yaml`);
    if (!bakedRepo.exists) return;

    const result = await super.exec(
      [
        `mkdir -p ${SANDBOX_WORKSPACE_DIR}/repos/github.com/iterate`,
        `rm -rf ${BAKED_ITERATE_REPO_WORKSPACE_DIR}`,
        `ln -s ${BAKED_ITERATE_REPO_SOURCE_DIR} ${BAKED_ITERATE_REPO_WORKSPACE_DIR}`,
      ].join(" && "),
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `linking baked Iterate repo failed (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }
}
