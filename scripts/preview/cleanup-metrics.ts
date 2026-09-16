import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { envs, streamsExampleEnvs } from "../../envs.ts";

/**
 * Read-only evidence for preview cleanup. Prefix these commands with
 * `doppler run --project _shared --config preview -- pnpm exec trpc-cli`:
 *
 * scripts/preview/cleanup-metrics.ts snapshot --env preview_15 --output /tmp/namespaces.json
 * scripts/preview/cleanup-metrics.ts capture --env preview_15 \
 *   --start 2026-09-16T22:00:00Z --end 2026-09-16T22:30:00Z \
 *   --namespace-snapshot /tmp/namespaces.json --output /tmp/metrics.json
 *
 * Snapshot after deployment, before cleanup: namespace retirement can remove
 * historical analytics. Storage-only cleanup should leave these IDs unchanged.
 * Query completed windows again after 30–60 minutes to allow ingestion to settle.
 * Empty recent results alone do not prove inactivity. The output keeps object
 * identities, sampling intervals and raw metric values for later comparison.
 */
export default class CleanupMetrics {
  /** Save OS and streams-example namespace identities before they can be retired. */
  async snapshot(options: { env: string; output: string }) {
    const target = resolveTarget(options.env);
    const namespaces: z.infer<typeof Namespace>[] = [];
    for (let page = 1; ; page++) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/durable_objects/namespaces?per_page=100&page=${page}`,
        { headers: target.headers, signal: AbortSignal.timeout(30_000) },
      );
      const body = NamespacePage.parse(await response.json());
      if (!response.ok || !body.success) {
        throw new Error(
          `Namespace listing failed (${response.status}): ${JSON.stringify(body.errors)}`,
        );
      }
      namespaces.push(...body.result.filter((entry) => target.workers.includes(entry.script)));
      if (page * 100 >= body.result_info.total_count) break;
    }
    if (!namespaces.length) throw new Error(`No deployed namespaces found for ${options.env}`);
    const snapshot = {
      capturedAt: new Date().toISOString(),
      env: options.env,
      accountId: target.accountId,
      namespaces,
    };
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(snapshot, null, 2) + "\n");
    return {
      output: options.output,
      namespaces: namespaces.length,
      capturedAt: snapshot.capturedAt,
    };
  }

  /** Capture per-object duration and invocations for an explicit UTC window. */
  async capture(options: {
    env: string;
    start: string;
    end: string;
    namespaceSnapshot: string;
    output: string;
  }) {
    const start = z.iso.datetime().parse(options.start);
    const end = z.iso.datetime().parse(options.end);
    if (Date.parse(start) >= Date.parse(end)) throw new Error("Start must precede end");
    if (Date.parse(end) > Date.now()) throw new Error("End must not be in the future");
    const target = resolveTarget(options.env);
    const snapshot = Snapshot.parse(JSON.parse(await readFile(options.namespaceSnapshot, "utf8")));
    if (snapshot.env !== options.env || snapshot.accountId !== target.accountId) {
      throw new Error("Namespace snapshot must belong to the requested environment and account");
    }
    if (!snapshot.namespaces.every((entry) => target.workers.includes(entry.script))) {
      throw new Error("Namespace snapshot includes a worker outside the requested environment");
    }
    const captureStartedAt = new Date().toISOString();
    const results = [];
    for (const namespace of snapshot.namespaces) {
      const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: target.headers,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          query: metricsQuery,
          variables: { account: target.accountId, namespace: namespace.id, start, end },
        }),
      });
      const body = GraphqlEnvelope.parse(await response.json());
      if (!response.ok || body.errors?.length) {
        throw new Error(
          `Analytics query failed (${response.status}): ${JSON.stringify(body.errors)}`,
        );
      }
      const account = AccountMetrics.parse(body.data?.viewer.accounts[0]);
      if (account.periodic.length === 10_000 || account.invocations.length === 10_000) {
        throw new Error(
          `Analytics hit the row limit for ${namespace.name}; query a shorter window`,
        );
      }
      results.push({ namespace, ...account });
    }
    const periodic = results.flatMap((result) => result.periodic);
    const summary = {
      doHours: periodic.reduce((total, row) => total + row.sum.activeTime / 3.6e9, 0),
      gbSeconds: periodic.reduce((total, row) => total + row.sum.duration, 0),
      periodicRows: periodic.length,
      invocationRows: results.reduce((total, result) => total + result.invocations.length, 0),
      periodicSampleIntervals: [...new Set(periodic.map((row) => row.avg.sampleInterval))],
      invocationSampleIntervals: [
        ...new Set(
          results.flatMap((result) => result.invocations.map((row) => row.avg.sampleInterval)),
        ),
      ],
    };
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(
      options.output,
      JSON.stringify(
        {
          captureStartedAt,
          captureFinishedAt: new Date().toISOString(),
          start,
          end,
          snapshot,
          summary,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    return { output: options.output, ...summary };
  }
}

function resolveTarget(name: string) {
  const os = Object.entries(envs).find(([key]) => key === name)?.[1];
  const streams = Object.entries(streamsExampleEnvs).find(([key]) => key === name)?.[1];
  if (!os || !streams) throw new Error(`Unknown deployed environment ${name}`);
  const token = z.string().min(1).parse(process.env.CLOUDFLARE_API_TOKEN);
  return {
    accountId: os.cloudflareAccountId,
    workers: [os.osWorkerName, streams.workerName],
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
}

const Namespace = z.object({
  id: z.string(),
  name: z.string(),
  script: z.string(),
  class: z.string(),
});
const Snapshot = z.object({
  capturedAt: z.iso.datetime(),
  env: z.string(),
  accountId: z.string(),
  namespaces: z.array(Namespace).min(1),
});
const NamespacePage = z.object({
  success: z.boolean(),
  result: z.array(Namespace),
  result_info: z.object({ total_count: z.number() }),
  errors: z.unknown(),
});
const Periodic = z.object({
  dimensions: z.object({
    datetimeMinute: z.string(),
    namespaceId: z.string(),
    objectId: z.string(),
    name: z.string(),
  }),
  sum: z.object({
    activeTime: z.number(),
    duration: z.number(),
    cpuTime: z.number(),
    rowsWritten: z.number(),
    subrequests: z.number(),
  }),
  avg: z.object({ sampleInterval: z.number() }),
});
const Invocation = z.object({
  dimensions: z.object({
    datetimeMinute: z.string(),
    namespaceId: z.string(),
    objectId: z.string(),
    name: z.string(),
    scriptName: z.string(),
    scriptVersion: z.string(),
    type: z.string(),
    status: z.string(),
  }),
  sum: z.object({ requests: z.number(), errors: z.number(), wallTime: z.number() }),
  avg: z.object({ sampleInterval: z.number() }),
});
const AccountMetrics = z.object({ periodic: z.array(Periodic), invocations: z.array(Invocation) });
const GraphqlEnvelope = z.object({
  data: z.object({ viewer: z.object({ accounts: z.array(z.unknown()) }) }).nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

// Returned sums already account for sampling. Do not multiply by sampleInterval.
// duration is GB-seconds; activeTime/cpuTime are microseconds. Request wall times
// overlap, so invocation wallTime must not be added up to estimate billing.
const metricsQuery = `
query ($account: string!, $namespace: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      periodic: durableObjectsPeriodicGroups(
        limit: 10000
        filter: { namespaceId: $namespace, datetime_geq: $start, datetime_lt: $end }
        orderBy: [datetimeMinute_ASC]
      ) {
        dimensions { datetimeMinute namespaceId objectId name }
        sum { activeTime duration cpuTime rowsWritten subrequests }
        avg { sampleInterval }
      }
      invocations: durableObjectsInvocationsAdaptiveGroups(
        limit: 10000
        filter: { namespaceId: $namespace, datetime_geq: $start, datetime_lt: $end }
        orderBy: [datetimeMinute_ASC]
      ) {
        dimensions { datetimeMinute namespaceId objectId name scriptName scriptVersion type status }
        sum { requests errors wallTime }
        avg { sampleInterval }
      }
    }
  }
}`;
