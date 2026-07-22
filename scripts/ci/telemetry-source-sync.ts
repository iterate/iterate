import { durationMs, systemEvent, type PostHogEvent } from "./posthog-events.ts";

export type TelemetrySource = {
  name: string;
  dataSource: string;
  collect: () => Promise<PostHogEvent[]>;
};

export type TelemetrySourceFailure = {
  source: string;
  error: unknown;
};

type TelemetrySourceResult = {
  source: TelemetrySource;
  events: PostHogEvent[];
  health: PostHogEvent;
  failure?: TelemetrySourceFailure;
};

/**
 * Collects independent telemetry sources without letting one failed provider
 * erase healthy evidence from every other provider. Each source emits its own
 * queryable health event; callers still fail the job after delivering the
 * partial evidence and health events.
 */
export async function collectTelemetrySources(
  input: {
    repository: string;
    lookbackDays: number;
    telemetrySyncId: string;
    collectorHeadSha?: string;
    /** Groups run concurrently; sources sharing one credential run serially within a group. */
    sourceGroups: readonly (readonly TelemetrySource[])[];
  },
  now = () => new Date().toISOString(),
) {
  const results = (
    await Promise.all(
      input.sourceGroups.map(async (sources) => {
        const groupResults: TelemetrySourceResult[] = [];
        for (const source of sources) groupResults.push(await collectSource(source));
        return groupResults;
      }),
    )
  ).flat();

  return {
    events: results.flatMap((result) => [...result.events, result.health]),
    failures: results.flatMap((result) => (result.failure ? [result.failure] : [])),
  };

  async function collectSource(source: TelemetrySource): Promise<TelemetrySourceResult> {
    const startedAt = now();
    try {
      const events = await source.collect();
      return {
        source,
        events,
        health: sourceHealthEvent({
          repository: input.repository,
          lookbackDays: input.lookbackDays,
          telemetrySyncId: input.telemetrySyncId,
          collectorHeadSha: input.collectorHeadSha,
          source,
          startedAt,
          finishedAt: now(),
          status: "passed",
          eventCount: events.length,
        }),
      };
    } catch (error) {
      return {
        source,
        events: [],
        health: sourceHealthEvent({
          repository: input.repository,
          lookbackDays: input.lookbackDays,
          telemetrySyncId: input.telemetrySyncId,
          collectorHeadSha: input.collectorHeadSha,
          source,
          startedAt,
          finishedAt: now(),
          status: "failed",
          eventCount: 0,
          error,
        }),
        failure: { source: source.name, error },
      };
    }
  }
}

function sourceHealthEvent(input: {
  repository: string;
  lookbackDays: number;
  telemetrySyncId: string;
  collectorHeadSha?: string;
  source: TelemetrySource;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  eventCount: number;
  error?: unknown;
}) {
  const error = errorProperties(input.error);
  return systemEvent(
    "ci telemetry source sync finished",
    `ci-telemetry-source-sync:${input.telemetrySyncId}:${input.source.name}:${input.finishedAt}`,
    `ci-telemetry-source:${input.source.name}`,
    {
      repository: input.repository,
      telemetry_sync_id: input.telemetrySyncId,
      collector_head_sha: input.collectorHeadSha,
      telemetry_source: input.source.name,
      data_source: input.source.dataSource,
      status: input.status,
      event_count: input.eventCount,
      lookback_days: input.lookbackDays,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
      duration_ms: durationMs(input.startedAt, input.finishedAt),
      ...error,
    },
    input.finishedAt,
  );
}

function errorProperties(error: unknown) {
  if (error === undefined) return {};
  if (error instanceof Error) {
    return { error_name: error.name, error_message: error.message.slice(0, 1_000) };
  }
  return { error_name: "NonErrorThrown", error_message: String(error).slice(0, 1_000) };
}
