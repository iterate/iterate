import { readFile } from "node:fs/promises";
import { z } from "zod";
import { envs } from "../../envs.ts";
import { resolveEnvContext } from "../lib/env-context.ts";

// Called after the test runners finish: trace indexing can lag the request,
// and fetching links must not serialize smoke, Vitest or browser startup.
const Creations = z.array(z.object({ projectId: z.string(), slug: z.string(), from: z.number() }));
const Telemetry = z.object({
  events: z.object({
    events: z.array(
      z.object({
        source: z.object({ traceId: z.string().optional() }),
      }),
    ),
  }),
});

try {
  const records = Creations.parse(JSON.parse(await readFile(process.argv[2], "utf8")));
  const context = await resolveEnvContext({
    envs,
    dopplerProject: "os",
    env: process.env.DOPPLER_CONFIG,
  });
  for (const record of records) {
    const result = Telemetry.parse(
      await context.cf("/workers/observability/telemetry/query", {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          queryId: "ci-project-creation-traces",
          timeframe: { from: record.from, to: Date.now() },
          view: "events",
          limit: 100,
          parameters: {
            datasets: ["otel"],
            filters: [
              {
                key: "$metadata.service",
                operation: "eq",
                type: "string",
                value: context.env.osWorkerName,
              },
              {
                key: "iterate.projectId",
                operation: "eq",
                type: "string",
                value: record.projectId,
              },
            ],
          },
        }),
      }),
    );
    const ids = new Set(
      result.events.events.flatMap(({ source }) => (source.traceId ? [source.traceId] : [])),
    );
    console.log(`[project-creation traces] ${record.projectId} (${record.slug})`);
    for (const id of ids)
      console.log(
        `https://dash.cloudflare.com/${context.env.cloudflareAccountId}/observability/traces/${id}`,
      );
    if (ids.size === 0)
      console.log(
        `No indexed spans yet. Search iterate.projectId=${record.projectId} from ${new Date(record.from).toISOString()}.`,
      );
  }
} catch (error) {
  // Diagnostic lookup failure is explicit and must not turn a healthy product
  // test into a flake. The project/time lookup records remain in CI artifacts.
  console.warn("[project-creation traces] lookup unavailable", error);
}
