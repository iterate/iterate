/**
 * THE TELEMETRY LAKE OF ONE ACCOUNT, created idempotently (docs/telemetry.md#setting-up-an-account):
 * the bucket and its Data Catalog, the catalog token, compaction and snapshot expiration, and a
 * stream, sink and pipeline per table from apps/telemetry/schemas/. Once envs.ts names those streams,
 * it deploys the Worker with the OTLP secret, made once when Doppler has none, and points the two
 * OTLP destinations at the Worker with it; a destination's create and update post to the Worker
 * first. A fresh account takes two runs: the first prints the streams for envs.ts.
 *
 *   pnpm --dir apps/telemetry ensure-resources --env preview
 */
import { spawnSync } from "node:child_process";
import { createCli } from "trpc-cli";
import { CLOUDFLARE_API, isNotRoutedYet, retryPlatformFailures } from "iterate/platform-retry";
import { getEnv, telemetryEnvs } from "../../../envs.ts";
import { CloudflareApiError, resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import events from "../schemas/events.json" with { type: "json" };
import logs from "../schemas/logs.json" with { type: "json" };
import metrics from "../schemas/metrics.json" with { type: "json" };
import spans from "../schemas/spans.json" with { type: "json" };
import deploy from "./deploy.ts";

const SCHEMAS = { events, logs, spans, metrics };
/** A stream's columns, as schemas/*.json holds them and Pipelines reports them. */
type StreamSchema = (typeof SCHEMAS)[keyof typeof SCHEMAS];
/** The two OTLP destinations, by the dataset each exports; apps/os's wrangler config names them. */
const DESTINATIONS = { traces: "telemetry-traces", logs: "telemetry-logs" };

export default async function ensureResources(options: { env: string }) {
  const env = getEnv(options.env, telemetryEnvs);
  const { cf, secrets } = await resolveEnvContext(env, { dopplerProject: env.dopplerProject });
  const account = env.cloudflareAccountId;
  const doppler = (name: string, value: string) =>
    run(
      "doppler",
      ["secrets", "set", name, "--project", env.dopplerProject, "--config", env.dopplerConfig],
      value,
    );

  const { buckets } = await cf<{ buckets: { name: string }[] }>("/r2/buckets?per_page=1000");
  if (!buckets.some((bucket) => bucket.name === env.bucket))
    await cf("/r2/buckets", { method: "POST", body: JSON.stringify({ name: env.bucket }) });
  const catalog = await cf(`/r2-catalog/${env.bucket}`).catch((error: unknown) => {
    if (error instanceof CloudflareApiError && error.status === 404) return undefined;
    throw error;
  });
  if (!catalog) await cf(`/r2-catalog/${env.bucket}/enable`, { method: "POST" });

  // The token the sinks write with, compaction runs with and R2 SQL reads with; never the account's.
  // One revoked on Cloudflare is not replaced: delete it from Doppler to mint another.
  let catalogToken = secrets.TELEMETRY_CATALOG_TOKEN;
  if (!catalogToken) {
    const minted = await cf<{ value: string }>("/tokens", {
      method: "POST",
      body: JSON.stringify({
        name: `${env.bucket}-catalog`,
        // Permission groups by id (GET /accounts/{id}/tokens/permission_groups). A Data Catalog sink
        // refuses a token whose Data Catalog Write is the bucket's alone (measured 2026-09-30).
        policies: [
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.${account}`]: "*" },
            // Workers R2 Data Catalog Write
            permission_groups: [{ id: "d229766a2f7f4d299f20eaa8c9b1fde9" }],
          },
          {
            effect: "allow",
            resources: { [`com.cloudflare.edge.r2.bucket.${account}_default_${env.bucket}`]: "*" },
            // Workers R2 Storage Bucket Item Write, Workers R2 SQL Read
            permission_groups: [
              { id: "2efd5506f9c8494dacb1fa10a3e7d5b6" },
              { id: "f45430d92e2b4a6cb9f94f2594c141b8" },
            ],
          },
        ],
      }),
    });
    catalogToken = minted.value;
    doppler("TELEMETRY_CATALOG_TOKEN", catalogToken);
    console.log(`minted the catalog token, stored as TELEMETRY_CATALOG_TOKEN`);
  }
  await cf(`/r2-catalog/${env.bucket}/credential`, {
    method: "POST",
    body: JSON.stringify({ token: catalogToken }),
  });
  await cf(`/r2-catalog/${env.bucket}/maintenance-configs`, {
    method: "POST",
    body: JSON.stringify({
      compaction: { state: "enabled", target_size_mb: "128" },
      snapshot_expiration: { state: "enabled", max_snapshot_age: "1d", min_snapshots_to_keep: 5 },
    }),
  });

  type Stream = { id: string; name: string; schema: StreamSchema };
  const streams = await cf<Stream[]>("/pipelines/v1/streams?per_page=100");
  const sinks = await cf<{ name: string }[]>("/pipelines/v1/sinks?per_page=100");
  const pipelines = await cf<{ name: string }[]>("/pipelines/v1/pipelines?per_page=100");
  const found: Record<string, string> = {};
  for (const [table, schema] of Object.entries(SCHEMAS)) {
    const [streamName, sinkName, pipelineName] = ["stream", "sink", "pipeline"].map(
      (kind) => `telemetry_${table}_${kind}`,
    );
    const stream =
      streams.find((candidate) => candidate.name === streamName) ??
      (await cf<Stream>("/pipelines/v1/streams", {
        method: "POST",
        body: JSON.stringify({
          name: streamName,
          format: { type: "json" },
          http: { enabled: true, authentication: true },
          worker_binding: { enabled: true },
          schema,
        }),
      }));
    // A stream's schema never changes: a column change is a new table (docs/telemetry.md).
    if (columnsOf(stream.schema) !== columnsOf(schema))
      throw new Error(`${streamName}'s columns differ from schemas/${table}.json: add ${table}_v2`);
    found[table] = stream.id;
    if (!sinks.some((candidate) => candidate.name === sinkName))
      await cf("/pipelines/v1/sinks", {
        method: "POST",
        body: JSON.stringify({
          name: sinkName,
          type: "r2_data_catalog",
          format: { type: "parquet", compression: "zstd", row_group_bytes: 32 * 1024 * 1024 },
          config: {
            account_id: account,
            bucket: env.bucket,
            namespace: "telemetry",
            table_name: table,
            token: catalogToken,
            rolling_policy: { interval_seconds: 60 },
          },
        }),
      });
    if (!pipelines.some((candidate) => candidate.name === pipelineName))
      await cf("/pipelines/v1/pipelines", {
        method: "POST",
        body: JSON.stringify({
          name: pipelineName,
          sql: `INSERT INTO ${sinkName} SELECT * FROM ${streamName}`,
        }),
      });
    console.log(`telemetry.${table}: stream ${stream.id}, sink and pipeline present`);
  }
  // The Worker binds the streams by the ids in envs.ts, so bring-up ends in a reviewed commit.
  if (JSON.stringify(found) !== JSON.stringify(env.streams)) {
    console.log(`\nenvs.ts's telemetryEnvs.${env.name}.streams should be:\n`);
    console.log(`  streams: ${JSON.stringify(found, null, 2).replaceAll("\n", "\n  ")},\n`);
    throw new Error(`envs.ts is out of date for ${env.name}: update its streams, then run again`);
  }

  let secret = secrets.TELEMETRY_OTLP_SECRET;
  if (!secret) {
    secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    doppler("TELEMETRY_OTLP_SECRET", secret);
    console.log(`made the OTLP secret, stored as TELEMETRY_OTLP_SECRET`);
  }
  await deploy({ env: env.name });
  const destinations = await cf<{ slug: string }[]>("/workers/observability/destinations");
  for (const [dataset, name] of Object.entries(DESTINATIONS)) {
    const configuration = {
      type: "logpush",
      url: `${env.baseUrl}/v1/${dataset}`,
      headers: { "x-telemetry-secret": secret },
    };
    const exists = destinations.some((destination) => destination.slug === name);
    // A fresh Worker's hostname, and a new version's secret, reach Cloudflare's servers one by one:
    // a preflight answered by one that has not learned them yet changed nothing, and is sent again.
    await retryPlatformFailures(
      () =>
        exists
          ? cf(`/workers/observability/destinations/${name}`, {
              method: "PATCH",
              body: JSON.stringify({ enabled: true, configuration }),
            })
          : cf("/workers/observability/destinations", {
              method: "POST",
              body: JSON.stringify({
                name,
                enabled: true,
                configuration: { ...configuration, logpushDataset: `opentelemetry-${dataset}` },
              }),
            }),
      {
        area: "telemetry",
        schedule: CLOUDFLARE_API,
        idempotent: true,
        kind: (error) => (preflightMetAStaleServer(error) ? "disconnected" : "failed"),
        describe: () => ({ name: `destination ${name}` }),
      },
    );
    console.log(`destination ${name} posts to ${configuration.url}`);
  }
  console.log(`✅ ${env.name}'s telemetry lake is set up`);
}

/** A schema's columns as one string: what the stream holds is compared by name, type and required,
 *  whatever else Pipelines reports of each. */
const columnsOf = (schema: StreamSchema) =>
  schema.fields.map(({ name, type, required }) => `${name} ${type} ${required}`).join(", ");

/** Whether a destination's create or update failed on a preflight a server answered before it
 *  learned the Worker: Cloudflare's own not-found for a workers.dev hostname it does not route yet
 *  (`isNotRoutedYet`), or the previous version's 503 to the secret it does not know yet. */
function preflightMetAStaleServer(error: unknown) {
  const preflight = /Pre-flight check failed: HTTP (\d+): (.*?)'?$/m.exec(String(error));
  if (!preflight) return false;
  const status = Number(preflight[1]);
  return status === 503 || isNotRoutedYet({ status, headers: {}, body: preflight[2] });
}

/** `command` with `input` on its stdin: its output, which echoes the secret, goes nowhere. */
function run(command: string, args: string[], input: string) {
  const result = spawnSync(command, args, { input, stdio: ["pipe", "ignore", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

void createCli({ ...import.meta, name: "ensure-resources" }).run();
