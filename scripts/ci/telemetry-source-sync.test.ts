import { describe, expect, test } from "vitest";
import { systemEvent } from "./posthog-events.ts";
import { collectTelemetrySources } from "./telemetry-source-sync.ts";

describe("collectTelemetrySources", () => {
  test("retains healthy provider data and emits explicit health when another provider fails", async () => {
    const times = [
      "2026-07-22T12:00:00.000Z",
      "2026-07-22T12:00:01.000Z",
      "2026-07-22T12:00:02.000Z",
      "2026-07-22T12:00:03.000Z",
      "2026-07-22T12:00:04.000Z",
      "2026-07-22T12:00:05.000Z",
    ];
    const result = await collectTelemetrySources(
      {
        repository: "iterate/iterate",
        lookbackDays: 1,
        telemetrySyncId: "collector-run-123",
        collectorHeadSha: "abcdef",
        sourceGroups: [
          [
            {
              name: "github-actions",
              dataSource: "github-actions-api",
              collect: async () => [
                systemEvent("ci workflow finished", "workflow:1", "workflow:1", {}),
              ],
            },
            {
              name: "github-reviews",
              dataSource: "github-checks-reviews-and-threads-api",
              collect: async () => [systemEvent("ci review finished", "review:1", "review:1", {})],
            },
          ],
          [
            {
              name: "depot",
              dataSource: "depot-api",
              collect: async () => {
                throw new Error("DEPOT_CI_TELEMETRY_TOKEN is required");
              },
            },
          ],
        ],
      },
      () => times.shift()!,
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.source).toBe("depot");
    expect(result.events.map((event) => event.event)).toEqual([
      "ci workflow finished",
      "ci telemetry source sync finished",
      "ci review finished",
      "ci telemetry source sync finished",
      "ci telemetry source sync finished",
    ]);
    expect(
      result.events
        .filter((event) => event.event === "ci telemetry source sync finished")
        .map((event) => event.properties),
    ).toEqual([
      expect.objectContaining({
        telemetry_source: "github-actions",
        telemetry_sync_id: "collector-run-123",
        collector_head_sha: "abcdef",
        status: "passed",
        event_count: 1,
      }),
      expect.objectContaining({
        telemetry_source: "github-reviews",
        telemetry_sync_id: "collector-run-123",
        status: "passed",
        event_count: 1,
      }),
      expect.objectContaining({
        telemetry_source: "depot",
        status: "failed",
        event_count: 0,
        error_name: "Error",
        error_message: "DEPOT_CI_TELEMETRY_TOKEN is required",
      }),
    ]);
    expect(
      result.events
        .filter((event) => event.event === "ci telemetry source sync finished")
        .map((event) => event.properties.$insert_id),
    ).toEqual([
      "ci-telemetry-source-sync:collector-run-123:github-actions:2026-07-22T12:00:02.000Z",
      "ci-telemetry-source-sync:collector-run-123:github-reviews:2026-07-22T12:00:05.000Z",
      "ci-telemetry-source-sync:collector-run-123:depot:2026-07-22T12:00:03.000Z",
    ]);
  });

  test("records duration and bounds non-Error failure details", async () => {
    const longFailure = "x".repeat(1_100);
    const times = ["2026-07-22T12:00:00.000Z", "2026-07-22T12:00:02.000Z"];
    const result = await collectTelemetrySources(
      {
        repository: "iterate/iterate",
        lookbackDays: 1,
        telemetrySyncId: "collector-run-456",
        sourceGroups: [
          [
            {
              name: "depot",
              dataSource: "depot-api",
              collect: async () => Promise.reject(longFailure),
            },
          ],
        ],
      },
      () => times.shift()!,
    );

    expect(result.failures).toEqual([{ source: "depot", error: longFailure }]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.properties).toEqual(
      expect.objectContaining({
        status: "failed",
        duration_ms: 2_000,
        error_name: "NonErrorThrown",
        error_message: "x".repeat(1_000),
      }),
    );
  });

  test("serializes shared-credential sources while other groups run concurrently", async () => {
    let releaseActions!: () => void;
    const actionsGate = new Promise<void>((resolve) => {
      releaseActions = resolve;
    });
    let reviewsStarted = false;
    let depotStarted = false;
    const collection = collectTelemetrySources(
      {
        repository: "iterate/iterate",
        lookbackDays: 1,
        telemetrySyncId: "collector-run-789",
        sourceGroups: [
          [
            {
              name: "github-actions",
              dataSource: "github-actions-api",
              collect: async () => {
                await actionsGate;
                return [];
              },
            },
            {
              name: "github-reviews",
              dataSource: "github-reviews-api",
              collect: async () => {
                reviewsStarted = true;
                return [];
              },
            },
          ],
          [
            {
              name: "depot",
              dataSource: "depot-api",
              collect: async () => {
                depotStarted = true;
                return [];
              },
            },
          ],
        ],
      },
      () => "2026-07-22T12:00:00.000Z",
    );

    await Promise.resolve();
    expect(depotStarted).toBe(true);
    expect(reviewsStarted).toBe(false);
    releaseActions();
    await collection;
    expect(reviewsStarted).toBe(true);
  });
});
