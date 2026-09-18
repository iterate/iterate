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
    await using probe = await createProbe("ordinary-redeploy");
    const { evidence, deploy, request, observe, namespace } = probe;
    await probe.bootstrap();
    const previousNamespace = await namespace();
    assert.ok(previousNamespace);

    for (let round = 1; round <= evidence.rounds; round++) {
      const deployment = await deploy(`ordinary-redeploy-${round}`, true);
      // First-touch unique names immediately after Wrangler exits. Never retry a write.
      const operations = await Promise.all(
        Array.from({ length: 12 }, async () => {
          const id = randomUUID();
          const response = await request(`/work/${id}`, { durationMs: 15_000 }, deployment);
          return { id, response, followup: [] as any[] };
        }),
      );
      const trial = {
        round,
        deployment: deployment.build,
        previousNamespace,
        namespace: await namespace(),
        operations,
      };
      evidence.trials.push(trial);
      for (const operation of operations) {
        operation.followup = await observe(
          `/state/${operation.id}`,
          deployment,
          (r) => r.status === 200 && r.data.object?.build === deployment.build,
        );
      }
      assert.equal(trial.namespace, previousNamespace);
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
    await using probe = await createProbe("retire-recreate");
    const { evidence, deploy, request, observe, namespace } = probe;
    await probe.bootstrap();

    for (let round = 1; round <= evidence.rounds; round++) {
      const previousNamespace = await namespace();
      assert.ok(previousNamespace);
      await deploy(`retired-${round}`, false);
      assert.equal(await namespace(), null);
      const deployment = await deploy(`retire-recreate-${round}`, true);
      // First-touch unique names immediately after Wrangler exits. Never retry a write.
      const operations = await Promise.all(
        Array.from({ length: 12 }, async () => {
          const id = randomUUID();
          const response = await request(`/work/${id}`, { durationMs: 15_000 }, deployment);
          return { id, response, followup: [] as any[] };
        }),
      );
      const trial = {
        round,
        deployment: deployment.build,
        previousNamespace,
        namespace: await namespace(),
        operations,
      };
      evidence.trials.push(trial);
      for (const operation of operations) {
        operation.followup = await observe(
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
    await using probe = await createProbe("active-object-control");
    const { evidence, deploy, request, observe } = probe;
    const initial = await probe.bootstrap();
    const id = randomUUID();
    const inFlight = request(`/work/${id}`, { durationMs: 90_000 }, initial);
    const started = await observe(
      `/state/${id}`,
      initial,
      (r) => r.data.record?.status === "started",
    );
    evidence.checks.push({ kind: "control-started", attempts: started });
    assert.equal(
      started.at(-1)?.data.record?.status,
      "started",
      "Work must be active before redeploy",
    );

    const replacement = await deploy("active-object-control", true);
    const response = await inFlight;
    const followup = await observe(
      `/state/${id}`,
      replacement,
      (r) => r.status === 200 && r.data.object?.build === replacement.build,
    );
    const operation = { id, response, followup };
    evidence.trials.push({ deployment: replacement.build, operations: [operation] });

    assert.match(
      response.data.error?.message || "",
      /Durable Object reset because its code was updated/,
      JSON.stringify(operation),
    );
    const state = followup.at(-1).data;
    assert.equal(state.record?.status, "started", "Interrupted work must remain unfinished");
    assert.notEqual(state.object.bootId, state.record.bootId);
    assert.notEqual(state.object.versionId, state.record.versionId);
  },
);

async function createProbe(scenario: string) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  // This repo's preview account. Never target production, or reuse an existing Worker.
  assert.equal(account, "376ef7ed81b0573f93524de763666c15");
  assert.ok(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN is required");
  const rounds = Number(process.env.ROLLOUT_ROUNDS || 3);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
  const runId = randomUUID().slice(0, 8);
  const workerName = `do-rollout-probe-${runId}`;
  const directory = await mkdtemp(join(tmpdir(), `${workerName}-`));
  const evidenceDirectory = resolvePath(
    process.env.ROLLOUT_EVIDENCE_DIR || join(import.meta.dirname, "evidence.ignoreme"),
    runId,
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const token = randomUUID();
  const evidence: any = {
    runId,
    scenario,
    workerName,
    startedAt: Date.now(),
    rounds,
    deployments: [],
    trials: [],
    checks: [],
    cleanup: null,
  };
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const api = async (path: string, body: any) => {
    const response = await fetch(`${apiBase}${path}`, {
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
  };
  const existing = await api(`/workers/scripts/${workerName}/settings`, null);
  assert.equal(existing.status, 404, "Refuse to overwrite any existing Worker");
  const subdomain = await api("/workers/subdomain", null);
  assert.equal(subdomain.success, true, JSON.stringify(subdomain));
  const origin = `https://${workerName}.${subdomain.result.subdomain}.workers.dev`;
  evidence.origin = origin;

  const request = async (path: string, body: any, deployment: any) => {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
  };

  let touchedCloud = false;
  const deploy = async (build: string, live: boolean) => {
    await writeFile(
      join(directory, "worker.js"),
      live
        ? `const build = ${JSON.stringify(build)};\n${workerSource}`
        : `export default { fetch() { return Response.json({ parked: true, build: ${JSON.stringify(build)} }); } };`,
    );
    await writeFile(
      join(directory, "wrangler.json"),
      JSON.stringify(
        {
          name: workerName,
          account_id: account,
          main: "worker.js",
          compatibility_date: "2026-09-01",
          workers_dev: true,
          preview_urls: false,
          observability: { enabled: true, head_sampling_rate: 1 },
          version_metadata: { binding: "VERSION" },
          ...(live && {
            vars: { PROBE_TOKEN: token },
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
    const deployment: any = { build, live, startedAt: Date.now() };
    evidence.deployments.push(deployment);
    console.log(`Deploying ${build} (${workerName})`);
    touchedCloud = true;
    Object.assign(
      deployment,
      await command("wrangler", ["deploy", "--config", "wrangler.json"], directory),
    );
    deployment.output = deployment.output
      .replaceAll(token, "[redacted]")
      .replace(/env\.PROBE_TOKEN.*$/gm, "env.PROBE_TOKEN ([redacted])");
    deployment.versionId = deployment.output.match(/Current Version ID:\s*(\S+)/)?.[1];
    assert.equal(deployment.exitCode, 0, deployment.output);
    assert.ok(deployment.versionId, deployment.output);
    return deployment;
  };

  const namespace = async () => {
    const settings = await api(`/workers/scripts/${workerName}/settings`, null);
    assert.equal(settings.success, true, JSON.stringify(settings.errors));
    return (
      settings.result.bindings.find((binding: any) => binding.name === "PROBE")?.namespace_id ||
      null
    );
  };
  const observe = async (path: string, deployment: any, accepts: (response: any) => boolean) => {
    const attempts = [];
    // Read-only follow-ups may retry; every response is kept. Never retry an operation.
    for (let i = 0; i < 30; i++) {
      const response = await request(path, null, deployment);
      attempts.push(response);
      if (accepts(response)) break;
      await delay(500);
    }
    return attempts;
  };
  return {
    evidence,
    deploy,
    request,
    observe,
    namespace,
    async bootstrap() {
      const initial = await deploy("bootstrap", true);
      // Provision the new hostname before measuring a deployment. No measured deploy waits here.
      const readiness = await observe(
        "/health",
        initial,
        (r) => r.data.worker?.build === "bootstrap",
      );
      evidence.checks.push({ kind: "bootstrap", attempts: readiness });
      assert.equal(readiness.at(-1)?.data.worker?.build, "bootstrap");
      return initial;
    },
    async [Symbol.asyncDispose]() {
      // Preserve partial failures, and retire only our new class. Never delete Workers.
      if (touchedCloud) {
        try {
          const parked = await deploy("cleanup-parked", false);
          const attempts = await observe(
            "/health",
            parked,
            (r) => r.data.build === "cleanup-parked",
          );
          const remainingNamespace = await namespace();
          evidence.cleanup = { remainingNamespace, attempts };
          assert.equal(remainingNamespace, null);
          assert.equal(attempts.at(-1)?.data.build, "cleanup-parked");
        } catch (error: any) {
          evidence.cleanup = {
            error: error.message,
            recoveryConfig: join(directory, "wrangler.json"),
          };
        }
      }
      evidence.finishedAt = Date.now();
      // Query after parking, not wrangler tail: enabling a tail can itself restart a DO.
      try {
        evidence.telemetry = await api("/workers/observability/telemetry/query", {
          queryId: `rollout-${runId}`,
          dry: true,
          view: "events",
          limit: 2000,
          timeframe: { from: evidence.startedAt, to: evidence.finishedAt },
          parameters: {
            datasets: [],
            filters: [
              { key: "$metadata.service", operation: "eq", type: "string", value: workerName },
            ],
            needle: { value: "code was updated", matchCase: false },
          },
        });
      } catch (error: any) {
        evidence.telemetry = { error: error.message };
      }
      await writeFile(
        join(evidenceDirectory, "evidence.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      console.log(`Evidence: ${evidenceDirectory}/evidence.json`);
      if (!touchedCloud || (evidence.cleanup && !evidence.cleanup.error))
        await rm(directory, { recursive: true });
      assert.equal(
        evidence.cleanup?.remainingNamespace,
        null,
        "Cleanup must retire the probe namespace",
      );
      assert.ok(!evidence.cleanup?.error, evidence.cleanup?.error);
    },
  };
}

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
