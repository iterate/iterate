import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { cloudflareAccounts } from "../../envs.ts";

/** Isolated preview-account experiment. Run with `pnpm exec trpc-cli experiments/playwright-otel/probe.ts`. */
export default class ProbeExperiment {
  async updateWorker() {
    const body = new FormData();
    body.set(
      "metadata",
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: "2026-06-01",
        keep_bindings: ["plain_text", "durable_object_namespace"],
        observability: {
          enabled: true,
          head_sampling_rate: 1,
          traces: { enabled: true, persist: true, head_sampling_rate: 1 },
        },
      }),
    );
    body.set(
      "worker.js",
      new Blob([await readFile(new URL("worker.js", import.meta.url))], {
        type: "application/javascript+module",
      }),
      "worker.js",
    );
    const result = await this.api(`/workers/scripts/${worker}`, { method: "PUT", body });
    await this.api(`/workers/scripts/${worker}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });
    return { status: result.status, version: result.result?.version?.id };
  }

  async deploy() {
    const key = randomBytes(24).toString("hex");
    await writeFile(
      new URL("credentials.ignoreme.json", import.meta.url),
      JSON.stringify({ key }),
      { mode: 0o600 },
    );
    const body = new FormData();
    body.set(
      "metadata",
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: "2026-06-01",
        bindings: [
          { type: "plain_text", name: "PROBE_KEY", text: key },
          { type: "durable_object_namespace", name: "PROBE", class_name: "Probe" },
        ],
        migrations: { new_tag: "v1", new_sqlite_classes: ["Probe"] },
        observability: {
          enabled: true,
          head_sampling_rate: 1,
          traces: { enabled: true, persist: true, head_sampling_rate: 1 },
        },
      }),
    );
    body.set(
      "worker.js",
      new Blob([await readFile(new URL("worker.js", import.meta.url))], {
        type: "application/javascript+module",
      }),
      "worker.js",
    );
    await this.api(`/workers/scripts/${worker}`, { method: "PUT", body });
    await this.api(`/workers/scripts/${worker}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    const subdomain = await this.api("/workers/subdomain", {});
    const url = `https://${worker}.${subdomain.result.subdomain}.workers.dev`;
    await writeFile(
      new URL("credentials.ignoreme.json", import.meta.url),
      JSON.stringify({ key, url }),
      { mode: 0o600 },
    );
    return { worker, url };
  }

  async propagation() {
    const outcome = await this.api(
      `/workers/scripts/${worker}/script-settings`,
      {
        method: "PATCH",
        body: JSON.stringify({
          observability: {
            enabled: true,
            traces: {
              enabled: true,
              persist: true,
              head_sampling_rate: 1,
              propagation_policy: "accept",
            },
          },
        }),
      },
      false,
    );
    await writeFile(
      new URL("evidence/propagation.json", import.meta.url),
      JSON.stringify(outcome, null, 2),
    );
    return outcome;
  }

  async query(options: { dataset: string; minutes: number }) {
    const outcome = await this.api("/workers/observability/telemetry/query", {
      method: "POST",
      body: JSON.stringify({
        queryId: "playwright-otel-probe",
        view: "events",
        limit: 1000,
        timeframe: { from: Date.now() - options.minutes * 60_000, to: Date.now() },
        parameters: {
          datasets: [options.dataset],
          filters: [{ key: "$metadata.service", operation: "eq", value: worker, type: "string" }],
          limit: 1000,
        },
      }),
    });
    const parsed = z
      .object({
        result: z.object({
          events: z.object({
            events: z.array(z.object({ source: z.record(z.string(), z.unknown()) })),
          }),
        }),
      })
      .parse(outcome);
    const spans = parsed.result.events.events.map(({ source }) => source);
    await writeFile(
      new URL(`evidence/${options.dataset}.json`, import.meta.url),
      JSON.stringify(spans, null, 2),
    );
    return { events: spans.length };
  }

  async disable() {
    await this.api(`/workers/scripts/${worker}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: false, previews_enabled: false }),
    });
    const result = await this.api(`/workers/scripts/${worker}/subdomain`, {});
    await writeFile(
      new URL("evidence/disabled.json", import.meta.url),
      JSON.stringify(result, null, 2),
    );
    return result;
  }

  private async api(path: string, options: RequestInit, requireSuccess = true) {
    const account = cloudflareAccounts["dev/preview"];
    const token = execFileSync(
      "doppler",
      [
        "secrets",
        "get",
        "CLOUDFLARE_API_TOKEN",
        "--plain",
        "--project",
        account.dopplerProject,
        "--config",
        account.dopplerConfig,
      ],
      { encoding: "utf8" },
    ).trim();
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account.cloudflareAccountId}${path}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        },
      },
    );
    const body = await response.json();
    if (requireSuccess && !response.ok)
      throw new Error(JSON.stringify({ status: response.status, body }));
    return { status: response.status, ...body };
  }
}

const worker = "playwright-otel-probe-01a09f64";
