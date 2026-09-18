// EXPERIMENT ONLY. Real preview routing; no product deploy policy changes. See README.md.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import {
  createSemaphoreClient,
  type SemaphoreLeaseRecord,
} from "../../apps/semaphore/src/contract.ts";
import { envs, previewEnvironmentSlotNumbers, semaphoreEnvs } from "../../envs.ts";
import { createSemaphoreTokenProvider } from "../../scripts/auth/semaphore-token.ts";

test.each(["direct", "keep-old", "park-old"] as const)(
  "EXPERIMENT unique Worker per run: %s",
  { skip: process.env.RUN_WORKER_PER_RUN !== "1" },
  async (handoff) => {
    await using probe = await Probe.create(handoff);
    let previous = await probe.deploy("before", "live");
    if (handoff !== "direct") {
      await probe.switchRoute(previous.name);
      await probe.ready(probe.origin, previous);
    }

    for (let round = 1; round <= probe.rounds; round++) {
      // Each build gets a new Worker name and namespace. No code update to existing DOs.
      const current = await probe.deploy(`after-${round}`, "live");
      const trial: any = { round, previous, current, operations: [] };
      probe.evidence.trials.push(trial);
      const origin = handoff === "direct" ? current.origin : probe.origin;
      if (handoff !== "direct") trial.cutover = await probe.switchRoute(current.name);

      // Parking runs concurrently with readiness/work so its deploy time cannot act as
      // a hidden settling delay. Keep-old tests whether stale routing alone is enough to fail.
      const retirement =
        handoff === "park-old"
          ? probe.park(previous).then(
              () => ({ ok: true }),
              (error) => ({ error: String(error) }),
            )
          : Promise.resolve({ ok: true });
      try {
        trial.readiness = await probe.ready(origin, current);
        // Explicit experiment variable: compare immediate writes with a short settling window.
        if (probe.settleMs) await delay(probe.settleMs);
        trial.workStartedAt = Date.now();
        // One new-version response, then first-touch twelve different names. Never retry work.
        trial.operations = await Promise.all(
          Array.from({ length: 12 }, async (_, i) => {
            const id = `${String.fromCharCode(97 + i).repeat(3)}-${randomUUID()}`;
            return {
              id,
              response: await probe.request(origin, `/work/${id}`, { durationMs: 15_000 }),
              observations: [] as any[],
            };
          }),
        );
        for (const operation of trial.operations) {
          operation.observations = await probe.observe(
            current.origin,
            `/state/${operation.id}`,
            (r) => r.status === 200 && r.data.object?.versionId === current.versionId,
          );
        }
        const identity = { name: current.name, build: current.build, versionId: current.versionId };
        for (const operation of trial.operations) {
          // Keep later rounds running while retaining every failed first operation as a failure.
          expect
            .soft({
              id: operation.id,
              response: operation.response,
              state: operation.observations.at(-1),
            })
            .toMatchObject({
              id: operation.id,
              response: {
                status: 200,
                data: {
                  worker: identity,
                  object: identity,
                  record: { ...identity, status: "completed" },
                },
              },
              state: {
                status: 200,
                data: { object: identity, record: { ...identity, status: "completed" } },
              },
            });
        }
      } finally {
        trial.retirement = await retirement;
        expect(trial.retirement).toMatchObject({ ok: true });
      }
      previous = current;
    }
  },
);

class Probe {
  #runId = randomUUID().slice(0, 8);
  #token = randomUUID();
  #directory = "";
  #evidenceDirectory = resolve(import.meta.dirname, "evidence.ignoreme", this.#runId);
  #semaphore = createSemaphoreClient({
    baseURL: semaphoreEnvs.prd.baseUrl,
    apiKey: createSemaphoreTokenProvider({
      baseUrl: semaphoreEnvs.prd.baseUrl,
      email: "preview-worker-experiment@iterate.com",
    }),
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
  }).resources;
  #lease: SemaphoreLeaseRecord | null = null;
  #account = "";
  #cfToken = "";
  #zoneId = "";
  #route: any;
  #routeTouched = false;
  #subdomain = "";
  #workers: Deployment[] = [];
  #slotNumber = "";
  origin = "";
  rounds = Number(process.env.WORKER_PER_RUN_ROUNDS || 3);
  settleMs = Number(process.env.WORKER_PER_RUN_SETTLE_MS || 0);
  evidence: any;

  /** Record the scenario; credentials and lease are resolved only after the explicit opt-in. */
  private constructor(handoff: string) {
    expect(Number.isInteger(this.rounds) && this.rounds >= 1 && this.rounds <= 10).toBe(true);
    expect(Number.isInteger(this.settleMs) && this.settleMs >= 0 && this.settleMs <= 30_000).toBe(
      true,
    );
    this.evidence = {
      settleMs: this.settleMs,
      observationBudgetMs: 90_000,
      runId: this.#runId,
      handoff,
      startedAt: Date.now(),
      deployments: [],
      cutovers: [],
      checks: [],
      trials: [],
      cleanup: {},
    };
  }

  /** Acquire an isolated slot and release it even if setup fails. */
  static async create(handoff: string) {
    const probe = new Probe(handoff);
    try {
      await probe.#init();
      return probe;
    } catch (error) {
      await probe[Symbol.asyncDispose]();
      throw error;
    }
  }

  /** Lease a free preview, load only its Cloudflare credentials, and snapshot its OS route. */
  async #init() {
    await mkdir(this.#evidenceDirectory, { recursive: true });
    this.#directory = await mkdtemp(join(tmpdir(), `worker-per-run-${this.#runId}-`));
    this.#lease = await this.#semaphore.acquire({
      type: "environment-config-lease",
      holder: `manual-worker-per-run-${this.#runId}`,
      leaseMs: 3_600_000,
      waitMs: 0,
      allowedSlugs: previewEnvironmentSlotNumbers.map((n) => `preview-${n}`),
    });
    expect(this.#lease, "Experiment needs a free slot; never evict another holder").toBeTruthy();
    this.evidence.lease = this.#lease;
    this.#slotNumber = this.#lease!.slug.replace("preview-", "");
    const configName = `preview_${this.#slotNumber}`;
    const environment = envs[configName as keyof typeof envs];
    expect(environment.cloudflareAccountId).toBe("376ef7ed81b0573f93524de763666c15");
    this.#account = environment.cloudflareAccountId;
    this.origin = environment.baseUrl;
    const secretsResult = await command(
      "doppler",
      [
        "secrets",
        "download",
        "--no-file",
        "--format",
        "json",
        "--project",
        "os",
        "--config",
        configName,
      ],
      process.cwd(),
      {},
    );
    // Never retain Doppler output in evidence or assertion diffs.
    expect(secretsResult.exitCode).toBe(0);
    const secrets = JSON.parse(secretsResult.output);
    expect(secrets.CLOUDFLARE_ACCOUNT_ID).toBe(this.#account);
    expect(Boolean(secrets.CLOUDFLARE_API_TOKEN)).toBe(true);
    this.#cfToken = secrets.CLOUDFLARE_API_TOKEN;
    const zones = await this.#api(
      `/zones?name=iterate-preview-${this.#slotNumber}.com&account.id=${this.#account}`,
      "GET",
      null,
    );
    expect(zones).toMatchObject({
      success: true,
      result: [{ name: `iterate-preview-${this.#slotNumber}.com` }],
    });
    this.#zoneId = zones.result[0].id;
    const routes = await this.#api(`/zones/${this.#zoneId}/workers/routes`, "GET", null);
    expect(routes).toMatchObject({ success: true });
    this.#route = routes.result.find(
      (r: any) => r.pattern === `${new URL(this.origin).hostname}/*`,
    );
    expect(this.#route, "Require an existing OS route to restore").toMatchObject({
      script: environment.osWorkerName,
    });
    this.evidence.originalRoute = this.#route;
    this.evidence.origin = this.origin;
    this.evidence.originalResponse = await this.request(this.origin, "/health", null);
    const subdomain = await this.#api(`/accounts/${this.#account}/workers/subdomain`, "GET", null);
    expect(subdomain).toMatchObject({ success: true });
    this.#subdomain = subdomain.result.subdomain;
    await this.#save();
    console.log(`EXPERIMENT ${this.#runId}: leased ${this.#lease!.slug}, route ${this.origin}`);
  }

  /** Check the fencing token before changing routing or renewing experimental resources. */
  async #renew() {
    expect(this.#lease).toBeTruthy();
    const renewed = await this.#semaphore.renew({
      type: this.#lease!.type,
      slug: this.#lease!.slug,
      leaseId: this.#lease!.leaseId,
      leaseMs: 3_600_000,
    });
    expect(renewed).toMatchObject({ leaseId: this.#lease!.leaseId });
  }

  /** Call only the preview Cloudflare account and retain HTTP status for diagnosis. */
  async #api(path: string, method: string, body: any) {
    expect(this.#account).toBe("376ef7ed81b0573f93524de763666c15");
    const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#cfToken}`, "Content-Type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: r.status, ...((await r.json()) as any) };
  }

  /** Deploy a unique script without routes; route ownership changes are measured separately. */
  async deploy(build: string, mode: "live" | "parked"): Promise<Deployment> {
    await this.#renew();
    const name = `os-preview-${this.#slotNumber}-exp-${this.#runId}-${build}`;
    const existing = await this.#api(
      `/accounts/${this.#account}/workers/scripts/${name}/settings`,
      "GET",
      null,
    );
    expect(existing, "Never overwrite a pre-existing Worker").toMatchObject({ status: 404 });
    const deployment = {
      name,
      build,
      origin: `https://${name}.${this.#subdomain}.workers.dev`,
      versionId: "",
      startedAt: Date.now(),
      finishedAt: 0,
      mode,
    };
    this.#workers.push(deployment);
    await this.#upload(deployment, mode);
    return deployment;
  }

  /** Write the embedded Worker/config and run Wrangler with explicit preview credentials. */
  async #upload(deployment: Deployment, mode: "live" | "parked") {
    const directory = join(this.#directory, deployment.name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "worker.js"),
      mode === "live"
        ? `const name=${JSON.stringify(deployment.name)}, build=${JSON.stringify(deployment.build)};\n${workerSource}`
        : `export default {fetch(){return Response.json({experiment:"worker-per-run",parked:true,name:${JSON.stringify(deployment.name)}},{status:503})}};`,
    );
    await writeFile(
      join(directory, "wrangler.json"),
      JSON.stringify(
        {
          name: deployment.name,
          account_id: this.#account,
          main: "worker.js",
          compatibility_date: "2026-09-01",
          workers_dev: true,
          preview_urls: false,
          observability: { enabled: true, head_sampling_rate: 1 },
          version_metadata: { binding: "VERSION" },
          ...(mode === "live" && {
            vars: { PROBE_TOKEN: this.#token },
            durable_objects: { bindings: [{ name: "PROBE", class_name: "Probe" }] },
          }),
          exports: {
            Probe:
              mode === "live"
                ? { type: "durable-object", storage: "sqlite" }
                : { type: "durable-object", state: "deleted" },
          },
        },
        null,
        2,
      ),
    );
    const attempt: any = {
      name: deployment.name,
      build: deployment.build,
      mode,
      startedAt: Date.now(),
    };
    this.evidence.deployments.push(attempt);
    await this.#save();
    console.log(`EXPERIMENT deploy ${deployment.name}: ${mode}`);
    const result = await command("wrangler", ["deploy", "--config", "wrangler.json"], directory, {
      CLOUDFLARE_ACCOUNT_ID: this.#account,
      CLOUDFLARE_API_TOKEN: this.#cfToken,
    });
    Object.assign(attempt, result, {
      output: result.output.replaceAll(this.#token, "[redacted]"),
      finishedAt: Date.now(),
    });
    expect(attempt).toMatchObject({ exitCode: 0 });
    const versionId = attempt.output.match(/Current Version ID:\s*(\S+)/)?.[1];
    expect(versionId).toEqual(expect.any(String));
    if (mode === "live") Object.assign(deployment, { versionId, finishedAt: attempt.finishedAt });
    else deployment.mode = "parked";
  }

  /** Point the existing route at a new script without deleting or creating DNS/routes. */
  async switchRoute(name: string) {
    await this.#renew();
    const cutover: any = { name, startedAt: Date.now() };
    this.evidence.cutovers.push(cutover);
    this.#routeTouched = true;
    cutover.response = await this.#api(
      `/zones/${this.#zoneId}/workers/routes/${this.#route.id}`,
      "PUT",
      { pattern: this.#route.pattern, script: name },
    );
    cutover.finishedAt = Date.now();
    expect(cutover.response).toMatchObject({ success: true, result: { script: name } });
    return cutover;
  }

  /** Park only a Worker created by this fixture, retiring its DO namespace. */
  async park(deployment: Deployment) {
    expect(this.#workers.includes(deployment)).toBe(true);
    await this.#renew();
    await this.#upload(deployment, "parked");
  }

  /** Send one request, retaining failures, exact identities and edge colo without retries. */
  async request(origin: string, path: string, body: any) {
    const startedAt = Date.now();
    try {
      const r = await fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        ...(body && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(body ? 35_000 : 5_000),
      });
      const text = await r.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { text: text.slice(0, 1000) };
      }
      return {
        startedAt,
        finishedAt: Date.now(),
        origin,
        path,
        status: r.status,
        ray: r.headers.get("cf-ray"),
        data,
      };
    } catch (error) {
      return {
        startedAt,
        finishedAt: Date.now(),
        origin,
        path,
        status: 0,
        data: { transportError: String(error) },
      };
    }
  }

  /** Bound readiness/state polling and keep all responses, including old builds and errors. */
  async observe(origin: string, path: string, accepts: (r: any) => boolean) {
    const attempts = [];
    // Measure convergence up to the existing CI gate's length, rather than stopping at
    // the original ~15s sampling cap. Return immediately on success; this is not a fixed wait.
    const deadline = Date.now() + 90_000;
    do {
      const response = await this.request(origin, path, null);
      attempts.push(response);
      if (accepts(response)) break;
      await delay(500);
    } while (Date.now() < deadline);
    return attempts;
  }

  /** Require one exact Worker+DO version response before first-use writes on other DO names. */
  async ready(origin: string, deployment: Deployment) {
    const attempts = await this.observe(
      origin,
      `/state/ready-${randomUUID()}`,
      (r) =>
        r.status === 200 &&
        r.data.worker?.versionId === deployment.versionId &&
        r.data.object?.versionId === deployment.versionId,
    );
    const check = { origin, name: deployment.name, attempts, readyAt: attempts.at(-1)!.finishedAt };
    this.evidence.checks.push(check);
    expect(attempts.at(-1), `Readiness for ${deployment.name}`).toMatchObject({
      status: 200,
      data: {
        worker: { name: deployment.name, versionId: deployment.versionId },
        object: { name: deployment.name, versionId: deployment.versionId },
        record: null,
      },
    });
    return check;
  }

  /** Checkpoint recovery information and evidence; never write credentials or probe tokens. */
  async #save() {
    await writeFile(
      join(this.#evidenceDirectory, "evidence.json"),
      JSON.stringify(this.evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  /** Restore the original route, retire all experimental DOs, then release the owned slot. */
  async [Symbol.asyncDispose]() {
    const errors: string[] = [];
    if (this.#lease && this.#routeTouched) {
      try {
        await this.switchRoute(this.#route.script);
        const routes = await this.#api(`/zones/${this.#zoneId}/workers/routes`, "GET", null);
        const restored = routes.result.find((r: any) => r.id === this.#route.id);
        expect(restored).toMatchObject(this.#route);
        const attempts = await this.observe(
          this.origin,
          "/health",
          (r) =>
            r.status === this.evidence.originalResponse.status &&
            r.data.experiment !== "worker-per-run",
        );
        expect(attempts.at(-1)).toMatchObject({ status: this.evidence.originalResponse.status });
        expect(attempts.at(-1)!.data.experiment).not.toBe("worker-per-run");
        this.evidence.cleanup.route = { restored, attempts };
      } catch (error) {
        errors.push(`route restoration: ${String(error)}`);
      }
    }
    for (const worker of this.#workers) {
      try {
        if (worker.mode !== "parked") await this.park(worker);
        const settings = await this.#api(
          `/accounts/${this.#account}/workers/scripts/${worker.name}/settings`,
          "GET",
          null,
        );
        expect(settings).toMatchObject({ success: true });
        expect(settings.result.bindings.some((b: any) => b.name === "PROBE")).toBe(false);
        const attempts = await this.observe(
          worker.origin,
          "/health",
          (r) => r.status === 503 && r.data.parked === true,
        );
        expect(attempts.at(-1)).toMatchObject({
          status: 503,
          data: { parked: true, name: worker.name },
        });
        (this.evidence.cleanup.workers ||= []).push({
          name: worker.name,
          classRetirementAcknowledged: true,
          attempts,
        });
      } catch (error) {
        errors.push(`${worker.name}: ${String(error)}`);
      }
    }
    if (this.#workers.length) {
      try {
        // Missing bindings alone do not prove namespace retirement. Check account state too.
        const matching: any[] = [];
        let complete = false;
        for (let page = 1; page <= 100; page++) {
          const namespaces = await this.#api(
            `/accounts/${this.#account}/workers/durable_objects/namespaces?per_page=100&page=${page}`,
            "GET",
            null,
          );
          expect(namespaces).toMatchObject({ success: true });
          matching.push(
            ...namespaces.result.filter((n: any) => this.#workers.some((w) => w.name === n.script)),
          );
          this.evidence.cleanup.namespaces = { matching, scannedPages: page };
          if (namespaces.result.length < 100) {
            complete = true;
            break;
          }
        }
        expect({ complete, matching }).toMatchObject({ complete: true, matching: [] });
      } catch (error) {
        errors.push(`namespace retirement: ${String(error)}`);
      }
    }
    this.evidence.finishedAt = Date.now();
    this.evidence.telemetry = [];
    for (const worker of this.#workers) {
      try {
        this.evidence.telemetry.push({
          name: worker.name,
          response: await this.#api(
            `/accounts/${this.#account}/workers/observability/telemetry/query`,
            "POST",
            {
              queryId: `per-run-${this.#runId}`,
              dry: true,
              view: "events",
              limit: 2000,
              timeframe: { from: this.evidence.startedAt, to: this.evidence.finishedAt },
              parameters: {
                datasets: [],
                filters: [
                  { key: "$metadata.service", operation: "eq", type: "string", value: worker.name },
                ],
              },
            },
          ),
        });
      } catch (error) {
        this.evidence.telemetry.push({ name: worker.name, error: String(error) });
      }
    }
    if (this.#lease && errors.length === 0) {
      try {
        this.evidence.cleanup.release = await this.#semaphore.release({
          type: this.#lease.type,
          slug: this.#lease.slug,
          leaseId: this.#lease.leaseId,
        });
        expect(this.evidence.cleanup.release).toMatchObject({ released: true });
      } catch (error) {
        errors.push(`lease release: ${String(error)}`);
      }
    }
    this.evidence.cleanup.errors = errors;
    if (errors.length) this.evidence.cleanup.recoveryDirectory = this.#directory;
    await this.#save();
    if (errors.length === 0 && this.#directory) await rm(this.#directory, { recursive: true });
    console.log(`EXPERIMENT evidence: ${this.#evidenceDirectory}/evidence.json`);
    expect(errors, "Cleanup must finish before returning the slot to the pool").toEqual([]);
  }
}

type Deployment = {
  name: string;
  build: string;
  origin: string;
  versionId: string;
  startedAt: number;
  finishedAt: number;
  mode: "live" | "parked";
};

/** Run a bounded CLI with separate output capture; callers decide what is safe to persist. */
async function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return await new Promise<{ exitCode: number | null; output: string }>(
    (resolvePromise, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: {
          ...process.env,
          ...env,
          PATH: (process.env.PATH || "")
            .split(delimiter)
            .map((p) => resolve(p))
            .join(delimiter),
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (part) => (output += part));
      child.stderr.on("data", (part) => (output += part));
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolvePromise({ exitCode, output });
      });
    },
  );
}

const workerSource = String.raw`
import { DurableObject } from "cloudflare:workers";
export class Probe extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.identity = {name, build, versionId:env.VERSION.id, bootId:crypto.randomUUID()}; }
  async work(durationMs) {
    if (await this.ctx.storage.get("work")) throw Error("No retries: operation already started");
    const record = {...this.identity,status:"started",startedAt:Date.now(),progress:0};
    await this.ctx.storage.put("work",record);
    console.log(JSON.stringify({event:"started",...record}));
    while (Date.now()-record.startedAt<durationMs) { await new Promise(resolve=>setTimeout(resolve,250)); record.progress++; await this.ctx.storage.put("work",record); }
    record.status="completed"; record.completedAt=Date.now(); await this.ctx.storage.put("work",record);
    console.log(JSON.stringify({event:"completed",...record}));
    return {object:this.identity,record};
  }
  async state() { return {object:this.identity,record:await this.ctx.storage.get("work")||null}; }
}
export default { async fetch(request,env) {
  if(request.headers.get("Authorization")!=="Bearer "+env.PROBE_TOKEN)return new Response("Unauthorized",{status:401});
  const worker={name,build,versionId:env.VERSION.id}, [,action,id]=new URL(request.url).pathname.split("/");
  const common={experiment:"worker-per-run",worker,colo:request.cf?.colo};
  if(action==="health")return Response.json(common);
  if(!id||!["work","state"].includes(action))return new Response("Not found",{status:404});
  try {
    const stub=env.PROBE.getByName(id);
    let result;
    if(action==="work") { const {durationMs}=await request.json(); if(durationMs!==15000)return new Response("Invalid duration",{status:400});result=await stub.work(durationMs); }
    else result=await stub.state();
    return Response.json({...common,...result});
  } catch(error) { const failure={...common,error:{message:error.message,name:error.name,stack:error.stack,durableObjectReset:error.durableObjectReset,retryable:error.retryable}};console.error(JSON.stringify(failure));return Response.json(failure,{status:500}); }
}};
`;
