import type { OutboundHandler } from "@cloudflare/containers";
import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "../../../env.ts";
import { DurableObjectNameCodec } from "../../durable-object-names.ts";
import { projectStub } from "../../projects/egress.ts";
import { PROJECT_REPO_PATH } from "../../repos/utils.ts";
import { normalizeSandboxPath } from "./utils.ts";

/** Where the project repo is cloned inside every sandbox container. */
const SANDBOX_PROJECT_REPO_DIR = "/workspace/repo";

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
 * Lifecycle is the SDK's, unchanged: getting the stub is cheap (no container),
 * the first command boots the container, and the SDK's durable `sleepAfter`
 * idle alarm (default 10m) stops it again. Identity and Durable Object storage
 * survive sleep; the container FILESYSTEM does not — restorability comes from
 * `onStart` re-provisioning (the repo clone below).
 *
 * Two behaviors are added over the stock SDK class:
 *
 * 1. Every container start kicks off a clone of the project repo to
 *    {@link SANDBOX_PROJECT_REPO_DIR}, so code in the sandbox finds the
 *    project's source checked out. Container filesystems are ephemeral — a
 *    restart is a fresh disk — which is why the clone re-runs per start rather
 *    than once at creation; `ensureProjectRepo()` is the awaitable guarantee.
 *
 * 2. ALL container egress is routed through the project's egress decision
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

  #repoClone: Promise<void> | undefined;

  override async onStart(): Promise<void> {
    await super.onStart();
    // `onStart` runs inside the container framework's blockConcurrencyWhile:
    // a hard ~30s budget whose cancellation resets the Durable Object AND
    // tears the fresh container down — and timer events are input-gated, so
    // the work cannot even bound itself with a deadline in here. The clone
    // therefore only STARTS here and completes in the background; a caller
    // that needs the repo deterministically awaits `ensureProjectRepo()`.
    //
    // Each start is a fresh container filesystem, so a clone promise from a
    // previous container must not satisfy this one.
    this.#repoClone = undefined;
    this.ctx.waitUntil(
      this.#ensureRepoClone().catch((error: unknown) =>
        console.error("sandbox project repo clone failed", error),
      ),
    );
  }

  /**
   * The project repo clone, awaitable: resolves once `/workspace/repo` holds
   * a completed clone for the CURRENT container. Idempotent and safe to call
   * any time — the clone starts automatically on every container start, so
   * this usually returns fast; await it before work that depends on the repo.
   */
  async ensureProjectRepo(): Promise<void> {
    // A container restart mid-await resets `#repoClone` (fresh filesystem),
    // so a clone that completed against the PREVIOUS container must not
    // satisfy this call — loop until the run we awaited is still current.
    while (true) {
      const run = this.#ensureRepoClone();
      await run;
      if (this.#repoClone === run) return;
    }
  }

  #ensureRepoClone(): Promise<void> {
    this.#repoClone ??= this.#cloneProjectRepo().catch((error: unknown) => {
      // Let the next ensure retry instead of caching the failure forever.
      this.#repoClone = undefined;
      throw error;
    });
    return this.#repoClone;
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
