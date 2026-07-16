import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Stream } from "../../../../../itx-api.generated.ts";
import type { StreamEvent } from "../../../schemas.ts";
import { browserProcessorStateStorage } from "../../browser/processor-state-storage.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserFeedContract } from "./contract.ts";
import { BrowserFeedProcessor } from "./implementation.ts";
import type { BrowserFeedState } from "./projector.ts";

type ScalarSqlValue = Exclude<SqlValue, number[]>;

function sqliteClient(): SqlClient {
  const database = new DatabaseSync(":memory:");
  return {
    exec: async (sql, params = []) =>
      database.prepare(sql).all(...(params as ScalarSqlValue[])) as Record<string, SqlValue>[],
    batch: async (statements, options) => {
      if (options?.transaction) database.exec("BEGIN");
      try {
        for (const statement of statements) {
          database.prepare(statement.sql).run(...((statement.params ?? []) as ScalarSqlValue[]));
        }
        if (options?.transaction) database.exec("COMMIT");
      } catch (error) {
        if (options?.transaction) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function event(
  offset: number,
  type: string,
  payload: Record<string, unknown>,
  ephemeral = false,
): StreamEvent {
  return {
    offset,
    type,
    payload,
    path: "/tests/live-feed",
    createdAt: new Date(offset * 1_000).toISOString(),
    ...(ephemeral ? { ephemeral: true as const } : {}),
  };
}

describe("BrowserFeedProcessor live ephemerals", () => {
  it("accepts only empty or current-schema reducer state", () => {
    const current = BrowserFeedContract.stateSchema.parse({});
    expect(current).toMatchObject({
      schemaVersion: 3,
      nextLocalIndex: 0,
    });
    expect(() =>
      BrowserFeedContract.stateSchema.parse({
        agent: {},
        open: null,
        nextLocalIndex: 0,
        provisionalAgentItemIndexes: {},
      }),
    ).toThrow(/current schema/);
    expect(() => BrowserFeedContract.stateSchema.parse({ ...current, agent: {} })).toThrow(
      /current schema/,
    );
    expect(() => BrowserFeedContract.stateSchema.parse({ ...current, open: {} })).toThrow(
      /current schema/,
    );
    expect(() =>
      BrowserFeedContract.stateSchema.parse({
        ...current,
        provisionalAgentItemIndexes: { impossible: -1 },
      }),
    ).toThrow(/current schema/);
  });

  it("renders live chunks from memory without persisting the chunk or its reduced state", async () => {
    const sql = sqliteClient();
    const storage = browserProcessorStateStorage<BrowserFeedState>({
      sql,
      processorSlug: BrowserFeedContract.slug,
    });
    const processor = new BrowserFeedProcessor({
      sql,
      stream: { append() {} } as unknown as Stream,
      path: "/tests/live-feed",
      projectId: null,
      readState: storage.readState,
      writeState: storage.writeState,
    });
    const requested = event(1, "events.iterate.com/agent/llm-request-requested", {
      model: "test/model",
    });
    const chunk = event(
      2,
      "events.iterate.com/agent/llm-response-chunk",
      { llmRequestOffset: 1, chunk: { response: "hello" } },
      true,
    );

    await processor.ingestLive({
      events: [requested, chunk],
      scannedAfterOffset: 0,
      scannedThroughOffset: 2,
      streamMaxOffset: 2,
    });

    expect(processor.agentUiState.live?.steps[0]).toMatchObject({
      kind: "llm",
      responseText: "hello",
    });
    expect(processor.state.agent.live?.steps[0]).toMatchObject({
      kind: "llm",
      responseText: "",
    });
    expect(await processor.snapshot()).toMatchObject({ offset: 2 });
    expect(await sql.exec(`SELECT COUNT(*) AS count FROM feed_items`)).toMatchObject([
      { count: 1 },
    ]);

    processor.clearVolatileState();
    expect(processor.agentUiState.live?.steps[0]).toMatchObject({ responseText: "" });
  });

  it("seeds a cold live tail from its persisted checkpoint and skips replay overlap", async () => {
    const sql = sqliteClient();
    const storage = browserProcessorStateStorage<BrowserFeedState>({
      sql,
      processorSlug: BrowserFeedContract.slug,
    });
    const constructorArgs = {
      sql,
      stream: { append() {} } as unknown as Stream,
      path: "/tests/live-feed",
      projectId: null,
      readState: storage.readState,
      writeState: storage.writeState,
    };
    const requested = event(1, "events.iterate.com/agent/llm-request-requested", {
      model: "test/model",
    });

    const writer = new BrowserFeedProcessor(constructorArgs);
    await writer.ingestLive({
      events: [requested],
      scannedAfterOffset: 0,
      scannedThroughOffset: 1,
      streamMaxOffset: 1,
    });

    // A new runtime may subscribe from a sibling processor's older checkpoint.
    // Its first live envelope can therefore overlap this feed's checkpoint.
    const reader = new BrowserFeedProcessor(constructorArgs);
    await reader.ingestLive({
      events: [requested],
      scannedAfterOffset: 0,
      scannedThroughOffset: 1,
      streamMaxOffset: 1,
    });

    expect(reader.agentUiState.live?.steps).toHaveLength(1);
    expect(reader.agentUiState.live?.steps[0]).toMatchObject({
      kind: "llm",
      llmRequestOffset: 1,
      model: "test/model",
    });
  });

  it("corrects a durable script result after the in-memory correction window was pruned", async () => {
    const sql = sqliteClient();
    const storage = browserProcessorStateStorage<BrowserFeedState>({
      sql,
      processorSlug: BrowserFeedContract.slug,
    });
    const processor = new BrowserFeedProcessor({
      sql,
      stream: { append() {} } as unknown as Stream,
      path: "/tests/live-feed",
      projectId: null,
      readState: storage.readState,
      writeState: storage.writeState,
    });
    const history = Array.from({ length: 40 }, (_, index) => {
      const requestedOffset = index * 2 + 1;
      return [
        event(requestedOffset, "events.iterate.com/capability-host/script-execution-requested", {
          executionId: `missing-${index}`,
          code: `async () => ${index}`,
          expiresAt: 15 * 60_000,
        }),
        event(requestedOffset + 1, "events.iterate.com/agent/status-changed", {
          busy: false,
          sinceOffset: requestedOffset,
        }),
      ];
    }).flat();

    await processor.ingest({
      events: history,
      scannedAfterOffset: 0,
      scannedThroughOffset: 80,
      streamMaxOffset: 80,
    });
    expect(processor.state.agent.provisionalActivities["activity-1"]).toBeUndefined();

    const completion = event(81, "events.iterate.com/capability-host/script-execution-completed", {
      executionId: "missing-0",
      settlement: { status: "succeeded", result: "durable truth" },
    });
    await processor.ingest({
      events: [completion],
      scannedAfterOffset: 80,
      scannedThroughOffset: 81,
      streamMaxOffset: 81,
    });

    const activityRows = await sql.exec(
      `SELECT json(data) AS data FROM feed_items WHERE kind = 'agent.activity'`,
    );
    const corrected = activityRows
      .map((row) => JSON.parse(String(row.data)) as { steps?: Record<string, unknown>[] })
      .find((activity) => activity.steps?.some((step) => step.executionId === "missing-0"));
    expect(corrected?.steps).toMatchObject([
      {
        kind: "code",
        executionId: "missing-0",
        outcomeSource: "durable",
        success: true,
        result: "durable truth",
      },
    ]);
    expect(corrected?.steps?.[0]).not.toHaveProperty("errorMessage");
  });
});
