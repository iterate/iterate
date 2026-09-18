// Manual, real-Cloudflare experiment. See README.md. No Iterate code or test fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test(
  "fresh objects complete work immediately after an ordinary redeploy",
  {
    skip: process.env.RUN_DO_ROLLOUT !== "1" && "Manual cloud experiment: set RUN_DO_ROLLOUT=1",
  },
  async () => {
    await using probe = await Probe.create("ordinary-redeploy");
    await probe.bootstrap();
    const previousNamespace = await probe.namespace();
    assert.ok(previousNamespace);

    for (let round = 1; round <= probe.evidence.rounds; round++) {
      const deployment = await probe.deploy(`ordinary-redeploy-${round}`, true);
      // First-touch new names as soon as deploy returns: /work saves 'started', does 15s
      // of work, then saves 'completed'. No readiness wait and no write retries.
      const operations = await Promise.all(
        Array.from({ length: 12 }, async () => {
          const id = randomUUID();
          const response = await probe.request(`/work/${id}`, { durationMs: 15_000 }, deployment);
          return { id, response, followup: [] as any[] };
        }),
      );
      const trial = {
        round,
        deployment: deployment.build,
        previousNamespace,
        namespace: await probe.namespace(),
        operations,
      };
      probe.evidence.trials.push(trial);
      // Read back through a DO on the new build. Its record survives restarts and keeps
      // the boot/version that started the work; object describes the instance reading it now.
      for (const operation of operations) {
        operation.followup = await probe.observe(
          `/state/${operation.id}`,
          deployment,
          (r) => r.status === 200 && r.data.object?.build === deployment.build,
        );
      }
      assert.equal(trial.namespace, previousNamespace);
      // Both the first call and durable record should say 'completed'. A later healthy
      // read must not turn a failed first call green; recorded runs hit code-update resets here.
      for (const operation of operations) {
        assert.equal(operation.response.status, 200, JSON.stringify(operation));
        assert.equal(
          operation.response.data.record?.status,
          "completed",
          JSON.stringify(operation),
        );
        assert.equal(
          operation.followup.at(-1).data.record?.status,
          "completed",
          JSON.stringify(operation),
        );
      }
    }
  },
);

test(
  "fresh objects complete work immediately after retiring and recreating their class",
  {
    skip: process.env.RUN_DO_ROLLOUT !== "1" && "Manual cloud experiment: set RUN_DO_ROLLOUT=1",
  },
  async () => {
    await using probe = await Probe.create("retire-recreate");
    await probe.bootstrap();

    for (let round = 1; round <= probe.evidence.rounds; round++) {
      const previousNamespace = await probe.namespace();
      assert.ok(previousNamespace);
      // Erase the namespace, then recreate the class under a new namespace ID. Old Workers
      // may still answer during rollout, so failures here do not prove old DOs survived erasure.
      await probe.deploy(`retired-${round}`, false);
      assert.equal(await probe.namespace(), null);
      const deployment = await probe.deploy(`retire-recreate-${round}`, true);
      // First-touch unique names immediately after Wrangler exits. Never retry a write.
      const operations = await Promise.all(
        Array.from({ length: 12 }, async () => {
          const id = randomUUID();
          const response = await probe.request(`/work/${id}`, { durationMs: 15_000 }, deployment);
          return { id, response, followup: [] as any[] };
        }),
      );
      const trial = {
        round,
        deployment: deployment.build,
        previousNamespace,
        namespace: await probe.namespace(),
        operations,
      };
      probe.evidence.trials.push(trial);
      for (const operation of operations) {
        operation.followup = await probe.observe(
          `/state/${operation.id}`,
          deployment,
          (r) => r.status === 200 && r.data.object?.build === deployment.build,
        );
      }
      assert.ok(trial.namespace);
      assert.notEqual(trial.namespace, previousNamespace);
      for (const operation of operations) {
        assert.equal(operation.response.status, 200, JSON.stringify(operation));
        assert.equal(
          operation.response.data.record?.status,
          "completed",
          JSON.stringify(operation),
        );
        assert.equal(
          operation.followup.at(-1).data.record?.status,
          "completed",
          JSON.stringify(operation),
        );
      }
    }
  },
);

test(
  "an active operation is interrupted by a code-update reset during redeploy",
  {
    skip: process.env.RUN_DO_ROLLOUT !== "1" && "Manual cloud experiment: set RUN_DO_ROLLOUT=1",
  },
  async () => {
    await using probe = await Probe.create("active-object-control");
    const initial = await probe.bootstrap();
    const id = randomUUID();
    // Unlike the fresh-object cases, start work BEFORE redeploy and confirm its durable
    // 'started' marker, so the deployment interrupts an operation we know is already active.
    const inFlight = probe.request(`/work/${id}`, { durationMs: 90_000 }, initial);
    const started = await probe.observe(
      `/state/${id}`,
      initial,
      (r) => r.data.record?.status === "started",
    );
    probe.evidence.checks.push({ kind: "control-started", attempts: started });
    assert.equal(
      started.at(-1)?.data.record?.status,
      "started",
      "Work must be active before redeploy",
    );

    const replacement = await probe.deploy("active-object-control", true);
    const response = await inFlight;
    const followup = await probe.observe(
      `/state/${id}`,
      replacement,
      (r) => r.status === 200 && r.data.object?.build === replacement.build,
    );
    const operation = { id, response, followup };
    probe.evidence.trials.push({ deployment: replacement.build, operations: [operation] });

    // This control should show a reset, unfinished work, and a new boot/version. It proves
    // we can detect interrupted work; by itself it says nothing about fresh objects after deploy.
    assert.match(
      response.data.error?.message || "",
      /Durable Object reset because its code was updated/,
      JSON.stringify(operation),
    );
    const state = followup.at(-1)!.data;
    assert.equal(state.record?.status, "started", "Interrupted work must remain unfinished");
    assert.notEqual(state.object.bootId, state.record.bootId);
    assert.notEqual(state.object.versionId, state.record.versionId);
  },
);

class Probe {
  #account = process.env.CLOUDFLARE_ACCOUNT_ID;
  #runId = randomUUID().slice(0, 8);
  #workerName = `do-rollout-probe-${this.#runId}`;
  #token = randomUUID();
  #apiBase = `https://api.cloudflare.com/client/v4/accounts/${this.#account}`;
  #evidenceDirectory = resolvePath(
    process.env.ROLLOUT_EVIDENCE_DIR || join(import.meta.dirname, "evidence.ignoreme"),
    this.#runId,
  );
  // #init fills these before create exposes the instance.
  #directory!: string;
  #origin!: string;
  #touchedCloud = false;
  evidence: any;

  /** Validate preview credentials and prepare this scenario's evidence record. */
  private constructor(scenario: string) {
    // This repo's preview account. Never target production, or reuse an existing Worker.
    assert.equal(this.#account, "376ef7ed81b0573f93524de763666c15");
    assert.ok(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN is required");
    const rounds = Number(process.env.ROLLOUT_ROUNDS || 3);
    assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
    this.evidence = {
      runId: this.#runId,
      scenario,
      workerName: this.#workerName,
      startedAt: Date.now(),
      rounds,
      deployments: [],
      trials: [],
      checks: [],
      cleanup: null,
    };
  }

  /** Return an initialized probe whose resources are owned by await using. */
  static async create(scenario: string) {
    const probe = new Probe(scenario);
    await probe.#init();
    return probe;
  }

  /** Check the Worker name is unused and prepare its URL and local directories. */
  async #init() {
    const existing = await this.#api(`/workers/scripts/${this.#workerName}/settings`, null);
    assert.equal(existing.status, 404, "Refuse to overwrite any existing Worker");
    const subdomain = await this.#api("/workers/subdomain", null);
    assert.equal(subdomain.success, true, JSON.stringify(subdomain));
    this.#origin = `https://${this.#workerName}.${subdomain.result.subdomain}.workers.dev`;
    this.evidence.origin = this.#origin;
    await mkdir(this.#evidenceDirectory, { recursive: true });
    this.#directory = await mkdtemp(join(tmpdir(), `${this.#workerName}-`));
  }

  /** Call the Cloudflare account API, keeping HTTP status and JSON error details. */
  async #api(path: string, body: any) {
    const response = await fetch(`${this.#apiBase}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data: any = await response.json();
    return { status: response.status, ...data };
  }

  /** Send one Worker request without retries, recording deployment age and failures. */
  async request(path: string, body: any, deployment: Awaited<ReturnType<typeof this.deploy>>) {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.#origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        ...(body && { body: JSON.stringify(body) }),
        // Control work spans a deployment; fresh work lasts 15s. A hung request is evidence.
        signal: AbortSignal.timeout(body ? body.durationMs + 20_000 : 5_000),
      });
      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
      return {
        startedAt,
        deployAgeMs: startedAt - deployment.finishedAt,
        finishedAt: Date.now(),
        status: response.status,
        data,
      };
    } catch (error: any) {
      return {
        startedAt,
        deployAgeMs: startedAt - deployment.finishedAt,
        finishedAt: Date.now(),
        status: 0,
        data: { transportError: error.message },
      };
    }
  }

  /** Deploy a live DO or retired class with Wrangler and record its version and timing. */
  async deploy(build: string, live: boolean) {
    await writeFile(
      join(this.#directory, "worker.js"),
      live
        ? `const build = ${JSON.stringify(build)};\n${workerSource}`
        : `export default { fetch() { return Response.json({ parked: true, build: ${JSON.stringify(build)} }); } };`,
    );
    await writeFile(
      join(this.#directory, "wrangler.json"),
      JSON.stringify(
        {
          name: this.#workerName,
          account_id: this.#account,
          main: "worker.js",
          compatibility_date: "2026-09-01",
          workers_dev: true,
          preview_urls: false,
          observability: { enabled: true, head_sampling_rate: 1 },
          version_metadata: { binding: "VERSION" },
          ...(live && {
            vars: { PROBE_TOKEN: this.#token },
            durable_objects: { bindings: [{ name: "PROBE", class_name: "Probe" }] },
          }),
          exports: {
            Probe: live
              ? { type: "durable-object", storage: "sqlite" }
              : { type: "durable-object", state: "deleted" },
          },
        },
        null,
        2,
      ),
    );
    const deployment = {
      build,
      live,
      startedAt: Date.now(),
      finishedAt: NaN,
      output: "",
      exitCode: undefined as number | undefined,
      versionId: undefined as string | undefined,
    };
    this.evidence.deployments.push(deployment);
    console.log(`Deploying ${build} (${this.#workerName})`);
    this.#touchedCloud = true;
    Object.assign(
      deployment,
      await command("wrangler", ["deploy", "--config", "wrangler.json"], this.#directory),
    );
    deployment.output = deployment.output
      .replaceAll(this.#token, "[redacted]")
      .replace(/env\.PROBE_TOKEN.*$/gm, "env.PROBE_TOKEN ([redacted])");
    deployment.versionId = deployment.output.match(/Current Version ID:\s*(\S+)/)?.[1] || "";
    assert.equal(deployment.exitCode, 0, deployment.output);
    assert.ok(deployment.versionId, deployment.output);
    return deployment;
  }

  /** Read the currently bound DO namespace ID, or null after retirement. */
  async namespace() {
    const settings = await this.#api(`/workers/scripts/${this.#workerName}/settings`, null);
    assert.equal(settings.success, true, JSON.stringify(settings.errors));
    return (
      settings.result.bindings.find((binding: any) => binding.name === "PROBE")?.namespace_id ||
      null
    );
  }

  /** Poll a read-only endpoint up to 30 times, retaining every response. */
  async observe(
    path: string,
    deployment: Awaited<ReturnType<typeof this.deploy>>,
    accepts: (response: any) => boolean,
  ) {
    const attempts = [];
    // Read-only follow-ups may retry; every response is kept. Never retry an operation.
    for (let i = 0; i < 30; i++) {
      const response = await this.request(path, null, deployment);
      attempts.push(response);
      if (accepts(response)) break;
      await delay(500);
    }
    return attempts;
  }

  /** Deploy the initial Worker and wait for its hostname before measured redeploys. */
  async bootstrap() {
    const initial = await this.deploy("bootstrap", true);
    // Provision the new hostname before measuring a deployment. No measured deploy waits here.
    const readiness = await this.observe(
      "/health",
      initial,
      (r) => r.data.worker?.build === "bootstrap",
    );
    this.evidence.checks.push({ kind: "bootstrap", attempts: readiness });
    assert.equal(readiness.at(-1)?.data.worker?.build, "bootstrap");
    return initial;
  }

  /** Retire the DO class, park the Worker, and save local evidence before cleanup. */
  async [Symbol.asyncDispose]() {
    // Preserve partial failures, and retire only our new class. Never delete Workers.
    if (this.#touchedCloud) {
      try {
        const parked = await this.deploy("cleanup-parked", false);
        const attempts = await this.observe(
          "/health",
          parked,
          (r) => r.data.build === "cleanup-parked",
        );
        const remainingNamespace = await this.namespace();
        this.evidence.cleanup = { remainingNamespace, attempts };
        assert.equal(remainingNamespace, null);
        assert.equal(attempts.at(-1)?.data.build, "cleanup-parked");
      } catch (error: any) {
        this.evidence.cleanup = {
          error: error.message,
          recoveryConfig: join(this.#directory, "wrangler.json"),
        };
      }
    }
    this.evidence.finishedAt = Date.now();
    // Query after parking, not wrangler tail: enabling a tail can itself restart a DO.
    try {
      this.evidence.telemetry = await this.#api("/workers/observability/telemetry/query", {
        queryId: `rollout-${this.#runId}`,
        dry: true,
        view: "events",
        limit: 2000,
        timeframe: { from: this.evidence.startedAt, to: this.evidence.finishedAt },
        parameters: {
          datasets: [],
          filters: [
            { key: "$metadata.service", operation: "eq", type: "string", value: this.#workerName },
          ],
          needle: { value: "code was updated", matchCase: false },
        },
      });
    } catch (error: any) {
      this.evidence.telemetry = { error: error.message };
    }
    await writeFile(
      join(this.#evidenceDirectory, "evidence.json"),
      `${JSON.stringify(this.evidence, null, 2)}\n`,
    );
    console.log(`Evidence: ${this.#evidenceDirectory}/evidence.json`);
    if (!this.#touchedCloud || (this.evidence.cleanup && !this.evidence.cleanup.error))
      await rm(this.#directory, { recursive: true });
    assert.equal(
      this.evidence.cleanup?.remainingNamespace,
      null,
      "Cleanup must retire the probe namespace",
    );
    assert.ok(!this.evidence.cleanup?.error, this.evidence.cleanup?.error);
  }
}

/** Run a bounded CLI command and capture its output, exit code, and finish time. */
async function command(executable: string, args: string[], cwd: string) {
  return await new Promise<{ exitCode: number | null; finishedAt: number; output: string }>(
    (resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: {
          ...process.env,
          // pnpm exec can supply relative PATH entries; keep them valid in the temp directory.
          PATH: (process.env.PATH || "")
            .split(delimiter)
            .map((entry) => resolvePath(entry))
            .join(delimiter),
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      // A stuck deploy must not leave the experiment unbounded; finally still parks the Worker.
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, finishedAt: Date.now(), output });
      });
    },
  );
}

const workerSource = String.raw`
import { DurableObject } from "cloudflare:workers";

export class Probe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.identity = { build, versionId: env.VERSION.id, bootId: crypto.randomUUID() };
  }
  async work(durationMs) {
    const existing = await this.ctx.storage.get("work");
    if (existing) throw new Error("Operation was already started; retries are forbidden");
    const record = { ...this.identity, status: "started", startedAt: Date.now(), progress: 0 };
    await this.ctx.storage.put("work", record);
    console.log(JSON.stringify({ event: "started", ...record }));
    // Yield between durable writes so a code update can interrupt genuinely unfinished work.
    while (Date.now() - record.startedAt < durationMs) {
      await new Promise(resolve => setTimeout(resolve, 250));
      record.progress++;
      await this.ctx.storage.put("work", record);
    }
    record.status = "completed";
    record.completedAt = Date.now();
    await this.ctx.storage.put("work", record);
    console.log(JSON.stringify({ event: "completed", ...record }));
    return { object: this.identity, record };
  }
  async state() {
    return { object: this.identity, record: await this.ctx.storage.get("work") || null };
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get("Authorization") !== "Bearer " + env.PROBE_TOKEN) return new Response("Unauthorized", { status: 401 });
    const worker = { build, versionId: env.VERSION.id };
    const [, action, id] = new URL(request.url).pathname.split("/");
    if (action === "health") return Response.json({ worker });
    if (!id || !["work", "state"].includes(action)) return new Response("Not found", { status: 404 });
    try {
      const stub = env.PROBE.getByName(id);
      let result;
      if (action === "work") {
        const { durationMs } = await request.json();
        if (![15000, 90000].includes(durationMs)) return new Response("Invalid duration", { status: 400 });
        result = await stub.work(durationMs);
      } else {
        result = await stub.state();
      }
      return Response.json({ worker, ...result });
    } catch (error) {
      const failure = { worker, error: { message: error.message, name: error.name, stack: error.stack, durableObjectReset: error.durableObjectReset, retryable: error.retryable, overloaded: error.overloaded } };
      console.error(JSON.stringify(failure));
      return Response.json(failure, { status: 500 });
    }
  }
};
`;
