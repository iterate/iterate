// EXPERIMENT ONLY. Uses real, exclusively leased preview slots; never changes normal CI policy.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSemaphoreClient,
  type SemaphoreLeaseRecord,
} from "../../apps/semaphore/src/contract.ts";
import {
  envs,
  semaphoreEnvs,
  previewEnvironmentSlotNumbers,
  PREVIEW_AND_DEV_ACCOUNT_ID,
} from "../../envs.ts";
import { createSemaphoreTokenProvider } from "../../scripts/auth/semaphore-token.ts";
import { resolveEnvContext, CloudflareApiError } from "../../scripts/lib/env-context.ts";
import { getWorkerDoNamespaces, resetWorkerDurableObjects } from "../../scripts/lib/do-reset.ts";
import { cloudflarePreviewApps } from "../../scripts/preview/preview.ts";
import { replacePreview, retirePreview } from "./lifecycle.ts";

const root = resolve(import.meta.dirname, "../..");
const leaseMs = 3 * 60 * 60_000;
const resourceType = "environment-config-lease";
const semaphore = createSemaphoreClient({
  baseURL: semaphoreEnvs.prd.baseUrl,
  apiKey: createSemaphoreTokenProvider({
    baseUrl: semaphoreEnvs.prd.baseUrl,
    email: "lease-cycling-experiment@iterate.com",
  }),
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
}).resources;

type Slot = {
  lease: SemaphoreLeaseRecord;
  acquired: number;
  source: string;
  stage: string;
  priorCleanup: { completedAt: number; releasedAt: number } | null;
  parkedAt: number | null;
  deletedAt: number | null;
  releasedAt: number | null;
  deployments: Record<string, { version: string; completedAt: number }>;
};
type Registry = { generation: number; current: string | null; pendingCleanup: string[] };

/** The CLI keeps a per-slot journal and an atomic current-preview pointer, independent of Git parents. */
export class Experiment {
  directory: string;
  #context = new Map<string, Awaited<ReturnType<typeof resolveEnvContext>>>();

  private constructor(id: string) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.equal(process.env.RUN_LEASE_CYCLING, "1", "Explicit RUN_LEASE_CYCLING=1 required");
    this.directory = join(import.meta.dirname, "evidence.ignoreme", id);
  }

  /** Open an existing experiment, or initialise its durable local journal. */
  static async create(id: string) {
    const experiment = new Experiment(id);
    await experiment.#init();
    return experiment;
  }

  /** Initialisation never acquires a lease or changes Cloudflare. */
  async #init() {
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(
        join(this.directory, "registry.json"),
        JSON.stringify({ generation: 0, current: null, pendingCleanup: [] }),
        { flag: "wx" },
      );
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  /** Read an ownership checkpoint; names are constrained before becoming file paths. */
  async slot(slug: string): Promise<Slot> {
    assert(previewEnvironmentSlotNumbers.some((n) => slug === `preview-${n}`));
    return JSON.parse(await readFile(join(this.directory, `${slug}.json`), "utf8"));
  }

  /** Save observed facts atomically; generated evidence never belongs in Git. */
  async save(slug: string, state: Slot) {
    const path = join(this.directory, `${slug}.json`);
    await writeFile(`${path}.${process.pid}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${path}.${process.pid}.tmp`, path);
  }

  /** Serialise publication and cleanup queue updates, never holding this lock while deploying. */
  async registry<T>(update: (registry: Registry) => T): Promise<T> {
    const lock = join(this.directory, "registry.lock");
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock);
        break;
      } catch (error: any) {
        if (error.code !== "EEXIST" || attempt === 100) throw error;
        await delay(100);
      }
    }
    try {
      const path = join(this.directory, "registry.json");
      const registry: Registry = JSON.parse(await readFile(path, "utf8"));
      const result = update(registry);
      await writeFile(`${path}.tmp`, JSON.stringify(registry, null, 2));
      await rename(`${path}.tmp`, path);
      return result;
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  /** Acquire the oldest available candidate; trust cleanup only if nobody has held it since our release. */
  async acquire(allowed: string[]) {
    const inventory = await semaphore.list({ type: resourceType });
    const available = inventory
      .filter((r) => r.leaseState === "available" && allowed.includes(r.slug))
      .sort((a, b) => (a.lastReleasedAt || 0) - (b.lastReleasedAt || 0));
    for (const resource of available) {
      let previous: Slot | null = null;
      try {
        previous = await this.slot(resource.slug);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      const clean =
        previous?.stage === "released" &&
        previous.releasedAt === resource.lastReleasedAt &&
        previous.acquired === resource.lastAcquiredAt;
      const lease = await semaphore.acquireSpecific({
        type: resourceType,
        slug: resource.slug,
        holder: `manual-lease-cycling-${this.directory.split("/").at(-1)}`,
        leaseMs,
        allowedSlugs: allowed,
      });
      if (!lease) continue;
      const current = await semaphore.find({ type: resourceType, slug: lease.slug });
      assert(current?.lastAcquiredAt);
      const state: Slot = {
        lease,
        acquired: current.lastAcquiredAt,
        source: execFileSync("git", ["rev-parse", "97ffd6fd65e5f2723de360b08247a45bf3c34d0e"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        stage: "acquired",
        priorCleanup:
          clean && current.lastReleasedAt === resource.lastReleasedAt
            ? { completedAt: previous!.deletedAt!, releasedAt: previous!.releasedAt! }
            : null,
        parkedAt: null,
        deletedAt: null,
        releasedAt: null,
        deployments: {},
      };
      await this.save(lease.slug, state);
      await this.record("acquired", { slug: lease.slug, priorCleanup: state.priorCleanup });
      return lease.slug;
    }
    throw new Error("No free candidate slot. Existing preview remains untouched.");
  }

  /** Renew using the exact lease token; an expired or stolen lease forbids all subsequent mutations. */
  async owned(slug: string) {
    const state = await this.slot(slug);
    const lease = await semaphore.renew({
      type: resourceType,
      slug,
      leaseId: state.lease.leaseId,
      leaseMs,
    });
    assert(lease, `Lost ownership of ${slug}; refusing to mutate`);
    return state;
  }

  /** Load only the selected preview account's credentials, never recording them in evidence. */
  async context(slug: string) {
    if (!this.#context.has(slug)) {
      await this.slot(slug);
      const context = await resolveEnvContext({
        envs,
        dopplerProject: "os",
        env: slug.replace("-", "_"),
      });
      assert.equal(context.env.cloudflareAccountId, PREVIEW_AND_DEV_ACCOUNT_ID);
      this.#context.set(slug, context);
    }
    return this.#context.get(slug)!;
  }

  /** Append one timestamped observation, safe across independent cleanup processes. */
  async record(event: string, data: unknown) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      join(this.directory, "events.jsonl"),
      JSON.stringify({ at: Date.now(), event, data }) + "\n",
    );
    console.log(event, JSON.stringify(data));
  }

  /** Run a bounded real command; keep logs on disk and heartbeat ownership while it runs. */
  async command(
    slug: string,
    label: string,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    budgetMs: number,
  ) {
    await this.owned(slug);
    const started = Date.now();
    const log = join(this.directory, `${slug}-${label}-${started}.log`);
    const fd = openSync(log, "a");
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    closeSync(fd);
    let failure: unknown;
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      failure = new Error(`${label} exceeded ${budgetMs}ms`);
      stop();
    }, budgetMs);
    const heartbeat = setInterval(() => {
      this.owned(slug).catch((error) => {
        failure = error;
        stop();
      });
    }, 30_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      await this.record("command", { slug, label, code, durationMs: Date.now() - started, log });
      if (failure) throw failure;
      assert.equal(code, 0, `${label} failed; see ${log}`);
      return await readFile(log, "utf8");
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }

  /** Existing erase scripts stop spend and wipe identities before a dirty slot can be deployed. */
  async park(slug: string) {
    for (const app of ["os", "streams-example-app"]) {
      await this.command(
        slug,
        `erase-${app}`,
        "pnpm",
        [
          "run",
          "erase-data",
          "--env",
          slug.replace("-", "_"),
          ...(app === "os" ? ["--preserve-artifacts"] : []),
        ],
        join(root, "apps", app),
        {},
        240_000,
      );
    }
    const state = await this.slot(slug);
    state.stage = "parked";
    state.parkedAt = Date.now();
    await this.save(slug, state);
    await this.record("parked", { slug, health: await this.health(slug) });
  }

  /** Observe unpinned public ingress, including the version and any stale parked response. */
  async health(slug: string) {
    await this.context(slug);
    const response = await fetch(
      `${envs[slug.replace("-", "_") as keyof typeof envs].baseUrl}/api/health`,
      { signal: AbortSignal.timeout(10_000), cache: "no-store" },
    );
    return {
      status: response.status,
      body: await response.text(),
      version: response.headers.get("x-iterate-worker-version"),
      ray: response.headers.get("cf-ray"),
    };
  }

  /** Deploy the real six-app fleet, then run unretried agent work at the measured OS deployment age. */
  async deploy(slug: string, waitMs: number) {
    assert(
      !(await this.registry((r) => r.pendingCleanup.includes(slug))),
      "Cannot deploy a retiring slot",
    );
    const lock = join(this.directory, `${slug}.mutation.lock`);
    await mkdir(lock);
    try {
      await this.#deploy(slug, waitMs);
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  /** Run the fleet while holding the per-slot mutation lock. */
  async #deploy(slug: string, waitMs: number) {
    assert([0, 15_000, 90_000].includes(waitMs));
    const before = await this.slot(slug);
    assert.equal(
      execFileSync(
        "git",
        [
          "diff",
          before.source,
          "--",
          "apps",
          "packages",
          "configs",
          "scripts",
          "envs.ts",
          "pnpm-lock.yaml",
        ],
        { cwd: root, encoding: "utf8" },
      ),
      "",
      "Experiment product must match its published package revision",
    );
    if (!before.priorCleanup) await this.park(slug);
    const state = await this.slot(slug);
    state.stage = "deploying";
    state.parkedAt = null;
    state.deletedAt = null;
    await this.save(slug, state);
    // Run dependencies before OS so itx/auth failure cannot masquerade as a DO rollout failure.
    for (const app of Object.values(cloudflarePreviewApps)
      .filter((a) => a.slug !== "os")
      .concat(cloudflarePreviewApps.os)) {
      const output = await this.command(
        slug,
        `deploy-${app.slug}`,
        "pnpm",
        ["run", "deploy", "--env", slug.replace("-", "_")],
        join(root, app.appPath),
        { PLATFORM_DEPLOY_HEAD_SHA: state.source },
        600_000,
      );
      const version = [...output.matchAll(/Current Version ID:\s*([a-f0-9-]+)/g)].at(-1)?.[1];
      assert(version, `No version in ${app.slug} deploy log`);
      state.deployments[app.slug] = { version, completedAt: Date.now() };
      await this.save(slug, state);
    }
    const health = await this.health(slug);
    await this.record("deployed", {
      slug,
      health,
      deployments: state.deployments,
      priorCleanup: state.priorCleanup,
    });
    assert.equal(health.status, 200);
    assert.equal(health.version, state.deployments.os.version);
    if (waitMs) await this.waitOwned(slug, state.deployments.os.completedAt + waitMs);
    await this.smoke(slug);
    state.stage = "ready";
    await this.save(slug, state);
  }

  /** The same create-project/create-agent/receive-reply behavior as CI, with one attempt and saved events. */
  async smoke(slug: string) {
    const state = await this.slot(slug);
    const context = await this.context(slug);
    const versions = Object.entries(state.deployments)
      .map(([app, d]) => {
        const config = Object.values(cloudflarePreviewApps)
          .find((a) => a.slug === app)!
          .resolvePreviewAppConfig(slug.replace("-", "_"));
        return `${config.workerName}="${d.version}"`;
      })
      .join(",");
    await this.record("smoke-start", {
      slug,
      ageMs: Date.now() - state.deployments.os.completedAt,
    });
    await this.command(
      slug,
      "smoke",
      "pnpm",
      ["exec", "tsx", join(import.meta.dirname, "smoke.ts")],
      root,
      {
        APP_CONFIG_ADMIN_API_SECRET: context.secrets.APP_CONFIG_ADMIN_API_SECRET,
        EXPERIMENT_ORIGIN: envs[slug.replace("-", "_") as keyof typeof envs].baseUrl,
        E2E_CLOUDFLARE_WORKERS_VERSION_OVERRIDES: versions,
      },
      120_000,
    );
  }

  /** Keep the lease while cooling; this duration is an experiment variable, not a readiness assertion. */
  async waitOwned(slug: string, until: number) {
    while (Date.now() < until) {
      await this.owned(slug);
      await delay(Math.min(15_000, until - Date.now()));
    }
  }

  /** Delete only this leased slot's fleet after removing its container apps/classes. Never force deletion. */
  async remove(slug: string) {
    await this.owned(slug);
    const ctx = await this.context(slug);
    const workerName = envs[slug.replace("-", "_") as keyof typeof envs].osWorkerName;
    await resetWorkerDurableObjects({
      ctx,
      workerName,
      cwd: join(root, "apps/os"),
      credentials: {
        CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
      },
      compatibilityDate: "2026-06-01",
      containerClassNames: [],
    });
    const names = [
      workerName,
      ...Object.values(cloudflarePreviewApps)
        .filter((a) => a.slug !== "os")
        .map((a) => a.resolvePreviewAppConfig(slug.replace("-", "_")).workerName),
      `${workerName}-typechecker`,
      `${workerName}-worker-bundler`,
    ];
    await this.record("before-delete", {
      slug,
      names,
      namespaces: await getWorkerDoNamespaces(ctx, workerName),
    });
    for (const name of names) {
      await this.owned(slug);
      try {
        await ctx.cf(`/workers/scripts/${name}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
      }
    }
    const state = await this.slot(slug);
    state.stage = "deleted";
    state.deletedAt = Date.now();
    await this.save(slug, state);
    await this.record("deleted", { slug, names });
  }

  /** Resumeable cleanup owns one lease continuously; errors retain it and the recovery journal. */
  async cleanup(slug: string) {
    const lock = join(this.directory, `${slug}.mutation.lock`);
    await mkdir(lock);
    try {
      assert.notEqual(
        await this.registry((r) => r.current),
        slug,
        "Cannot clean the current preview",
      );
      assert(
        (await this.slot(slug)).stage === "acquired" ||
          (await this.registry((r) => r.pendingCleanup.includes(slug))),
        "Cleanup requires a queued retirement or an undeployed acquired slot",
      );
      await this.registry((r) => {
        if (!r.pendingCleanup.includes(slug)) r.pendingCleanup.push(slug);
      });
      await retirePreview({
        assertOwned: async () => {
          await this.owned(slug);
        },
        park: async () => {
          if (!(await this.slot(slug)).parkedAt) await this.park(slug);
        },
        waitAfterPark: async () => {
          await this.waitOwned(slug, (await this.slot(slug)).parkedAt! + 150_000);
        },
        remove: async () => {
          if (!(await this.slot(slug)).deletedAt) await this.remove(slug);
        },
        waitAfterRemoval: async () => {
          await this.waitOwned(slug, (await this.slot(slug)).deletedAt! + 150_000);
        },
        verifyRemoved: async () => {
          const ctx = await this.context(slug);
          const scripts = await ctx.cf<{ id: string }[]>("/workers/scripts");
          const names = Object.values(cloudflarePreviewApps).map(
            (a) => a.resolvePreviewAppConfig(slug.replace("-", "_")).workerName,
          );
          assert(!scripts.some((s) => names.includes(s.id)));
          for (const name of names) assert.deepEqual(await getWorkerDoNamespaces(ctx, name), []);
          await this.record("verified-removed", { slug, names });
        },
        release: async () => {
          const state = await this.slot(slug);
          const result = await semaphore.release({
            type: resourceType,
            slug,
            leaseId: state.lease.leaseId,
          });
          assert(result.released);
          const resource = await semaphore.find({ type: resourceType, slug });
          state.stage = "released";
          state.releasedAt = resource!.lastReleasedAt;
          await this.save(slug, state);
          await this.registry((r) => {
            r.pendingCleanup = r.pendingCleanup.filter((s) => s !== slug);
          });
          await this.record("released", { slug, releasedAt: state.releasedAt });
        },
      });
    } catch (error) {
      await this.record("cleanup-failed-retaining-lease", { slug, error: String(error) });
      throw error;
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  /** Persist the job before launching a separate process; `cleanup` is the explicit recovery command. */
  async scheduleCleanup(slug: string) {
    await this.registry((r) => {
      if (!r.pendingCleanup.includes(slug)) r.pendingCleanup.push(slug);
    });
    const log = join(this.directory, `${slug}-cleanup-${Date.now()}.log`);
    const fd = openSync(log, "a");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", import.meta.filename, "cleanup", this.directory.split("/").at(-1)!, slug],
      { cwd: root, env: process.env, stdio: ["ignore", fd, fd], detached: true },
    );
    closeSync(fd);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    await this.record("cleanup-scheduled", { slug, pid: child.pid, log });
  }

  /** Capture routes, namespaces and sampled Worker logs without attaching a tail or waking DOs. */
  async inspect(slug: string) {
    const ctx = await this.context(slug);
    const state = await this.slot(slug);
    const config = envs[slug.replace("-", "_") as keyof typeof envs];
    const zoneName = new URL(config.baseUrl).hostname.replace(/^os\./, "");
    const zones = await ctx.cfV4<{ id: string }[]>(`/zones?name=${zoneName}`);
    assert.equal(zones.length, 1);
    const routes = await ctx.cfV4(`/zones/${zones[0].id}/workers/routes`);
    const namespaces = await getWorkerDoNamespaces(ctx, config.osWorkerName);
    const apps = await ctx.cf<{ name: string; durable_objects?: { namespace_id?: string } }[]>(
      "/containers/applications",
    );
    const containers = apps.filter((a) =>
      namespaces.some((n) => n.namespaceId === a.durable_objects?.namespace_id),
    );
    const telemetry = await ctx.cf("/workers/observability/telemetry/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queryId: `lease-cycle-${Date.now()}`,
        dry: true,
        view: "events",
        limit: 2000,
        timeframe: { from: state.acquired, to: Date.now() },
        parameters: {
          datasets: [],
          filters: [
            {
              key: "$metadata.service",
              operation: "eq",
              type: "string",
              value: config.osWorkerName,
            },
          ],
        },
      }),
    });
    const file = join(this.directory, `${slug}-inspection-${Date.now()}.json`);
    await writeFile(
      file,
      JSON.stringify({ at: Date.now(), state, routes, namespaces, containers, telemetry }, null, 2),
    );
    await this.record("inspection", {
      slug,
      file,
      namespaceCount: namespaces.length,
      containerCount: containers.length,
    });
  }

  /** Sample the published preview throughout a replacement; a parked/error response stays visible. */
  async watch(slug: string, durationMs: number) {
    assert(durationMs > 0 && durationMs <= 900_000);
    const until = Date.now() + durationMs;
    while (Date.now() < until) {
      const current = await this.registry((r) => r.current);
      if (current !== slug) {
        await this.record("watch-handoff", { previous: slug, current });
        return;
      }
      await this.record("old-preview-health", { slug, health: await this.health(slug) });
      await delay(5_000);
    }
  }

  /** Publish only the latest requested generation, retaining the previous preview through deployment and smoke. */
  async replace(allowed: string[], waitMs: number) {
    const generation = await this.registry((r) => ++r.generation);
    const old = await this.registry((r) => r.current);
    if (old) await this.owned(old);
    let oldLeaseFailure: unknown;
    const heartbeat = old
      ? setInterval(() => {
          this.owned(old).catch((error) => {
            oldLeaseFailure = error;
          });
        }, 30_000)
      : null;
    try {
      return await replacePreview({
        acquire: () => this.acquire(allowed),
        deploy: async (slug) => {
          await this.deploy(slug, waitMs);
          if (oldLeaseFailure) throw oldLeaseFailure;
          await this.owned(slug);
          if (old) await this.owned(old);
        },
        publish: async (slug) =>
          this.registry((r) => {
            if (r.generation !== generation) return { accepted: false, previous: null };
            const previous = r.current;
            r.current = slug;
            // Persist retirement intent in the same publication transaction.
            if (previous && !r.pendingCleanup.includes(previous)) r.pendingCleanup.push(previous);
            return { accepted: true, previous };
          }),
        scheduleCleanup: (slug) => this.scheduleCleanup(slug),
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

if (process.argv[1] === import.meta.filename) {
  const [action, id, arg, wait] = process.argv.slice(2);
  const experiment = await Experiment.create(id);
  if (action === "acquire") console.log(await experiment.acquire(arg.split(",")));
  else if (action === "replace")
    console.log(await experiment.replace(arg.split(","), Number(wait)));
  else if (action === "deploy") await experiment.deploy(arg, Number(wait));
  else if (action === "inspect") await experiment.inspect(arg);
  else if (action === "watch") await experiment.watch(arg, Number(wait));
  else if (action === "smoke") await experiment.smoke(arg);
  else if (action === "cleanup") await experiment.cleanup(arg);
  else if (action === "status") console.log(await experiment.registry((r) => r));
  else if (action === "finish") {
    const current = await experiment.registry((r) => {
      const slot = r.current;
      r.current = null;
      return slot;
    });
    if (current) await experiment.scheduleCleanup(current);
  } else
    throw new Error(
      "Use acquire|replace|deploy|smoke|cleanup|status|finish <experiment-id> [slot(s)] [wait-ms]",
    );
}
