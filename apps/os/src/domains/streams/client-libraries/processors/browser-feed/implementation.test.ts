import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { StreamProcessorRunner } from "iterate/processors";
import type { Stream } from "../../../../../itx-api.generated.ts";
import { BrowserStreamProcessorGroup } from "../../browser/browser-stream-processor-group.ts";
import { browserProcessorProgressStore } from "../../browser/processor-state-storage.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserFeedContract } from "./contract.ts";
import { BrowserFeedProcessor } from "./implementation.ts";
import type { BrowserFeedState } from "./projector.ts";

type ScalarSqlValue = Exclude<SqlValue, number[]>;

const TEST_STREAM_ID = "11111111-1111-4111-8111-111111111111";

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
    ...(ephemeral && { ephemeral: true as const }),
  };
}

function makeHarness(sql: SqlClient, progressKey = "browser-feed-test") {
  const stream = {
    append: async () => [],
    getEventPage: async () => ({
      streamId: TEST_STREAM_ID,
      streamMaxOffset: 0,
      events: [],
    }),
    readEvents: async () => [],
  } as unknown as Stream;
  const processor = new BrowserFeedProcessor({
    sql,
    stream,
    path: "/tests/live-feed",
    projectId: null,
  });
  const runner = new StreamProcessorRunner({
    processor,
    stream,
    durability: {
      progress: browserProcessorProgressStore<BrowserFeedState>({
        sql,
        processorSlug: BrowserFeedContract.slug,
        progressKey,
        ensureProjectionSchema: (client) => processor.ensureProjectionSchema(client),
        projection: processor.projectionBuffer,
      }),
    },
  });
  const processorGroup = new BrowserStreamProcessorGroup([
    { slug: BrowserFeedContract.slug, processor, runner },
  ]);
  return {
    processorGroup,
    processor,
    runner,
    async deliver(args: {
      events: StreamEvent[];
      scannedAfterOffset: number;
      scannedThroughOffset: number;
    }) {
      const opened = await processorGroup.openEventBatchCallback();
      await opened.processEventBatch({
        ...args,
        streamId: TEST_STREAM_ID,
        streamMaxOffset: args.scannedThroughOffset,
      });
    },
  };
}

describe("BrowserFeedProcessor live ephemerals", () => {
  it("accepts only empty or current-schema reducer state", () => {
    const current = BrowserFeedContract.stateSchema.parse({});
    expect(current).toMatchObject({
      schemaVersion: 8,
      nextLocalIndex: 0,
    });
    expect(() =>
      BrowserFeedContract.stateSchema.parse({
        agent: {},
        open: null,
        nextLocalIndex: 0,
        lastAgentWake: null,
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
    const harness = makeHarness(sql);
    const requested = event(1, "events.iterate.com/agent/llm-request-requested", {
      model: "test/model",
    });
    const chunk = event(
      2,
      "events.iterate.com/agent/llm-response-chunks",
      { llmRequestOffset: 1, chunks: [{ response: "hello" }] },
      true,
    );

    await harness.deliver({
      events: [requested, chunk],
      scannedAfterOffset: 0,
      scannedThroughOffset: 2,
    });

    expect(harness.processorGroup.agentUiState?.live?.steps[0]).toMatchObject({
      kind: "llm",
      responseText: "hello",
    });
    expect(harness.runner.currentState.agent.live?.steps[0]).toMatchObject({
      kind: "llm",
      responseText: "",
    });
    expect(await harness.runner.snapshot()).toMatchObject({ offset: 2 });
    expect(await sql.exec(`SELECT COUNT(*) AS count FROM feed_items`)).toMatchObject([
      { count: 1 },
    ]);

    harness.processorGroup.clearVolatileState();
    expect(harness.processorGroup.agentUiState).toBeNull();
    expect(harness.runner.currentState.agent.live?.steps[0]).toMatchObject({ responseText: "" });
  });

  it("starts new-event state from its stored checkpoint and skips replay overlap", async () => {
    const sql = sqliteClient();
    const requested = event(1, "events.iterate.com/agent/llm-request-requested", {
      model: "test/model",
    });

    const writer = makeHarness(sql);
    await writer.deliver({
      events: [requested],
      scannedAfterOffset: 0,
      scannedThroughOffset: 1,
    });

    // The shared callback starts from the smallest processor checkpoint. Its
    // first batch can therefore include offsets this feed already committed.
    const reader = makeHarness(sql);
    await reader.deliver({
      events: [requested],
      scannedAfterOffset: 0,
      scannedThroughOffset: 1,
    });

    expect(reader.runner.currentState.agent.live?.steps).toHaveLength(1);
    expect(reader.runner.currentState.agent.live?.steps[0]).toMatchObject({
      kind: "llm",
      llmRequestOffset: 1,
      model: "test/model",
    });
  });
});
