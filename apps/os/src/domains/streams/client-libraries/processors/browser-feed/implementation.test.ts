import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { StreamProcessorRunner } from "iterate/processors";
import type { Stream } from "../../../../../itx-api.generated.ts";
import { CompositeMirrorDrive } from "../../browser/composite-mirror-drive.ts";
import { browserProcessorProgressStore } from "../../browser/processor-state-storage.ts";
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

function makeHarness(sql: SqlClient, subscriptionKey = "browser-feed-test") {
  const stream = {
    append: async () => [],
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
        subscriptionKey,
        ensureProjectionSchema: (client) => processor.ensureProjectionSchema(client),
        projection: processor.projectionBuffer,
      }),
    },
  });
  const composite = new CompositeMirrorDrive([
    { slug: BrowserFeedContract.slug, processor, runner },
  ]);
  return {
    composite,
    processor,
    runner,
    async deliver(args: {
      events: StreamEvent[];
      scannedAfterOffset: number;
      scannedThroughOffset: number;
    }) {
      const opened = await composite.openDelivery();
      await opened.sink({ ...args, streamMaxOffset: args.scannedThroughOffset });
    },
  };
}

describe("BrowserFeedProcessor live ephemerals", () => {
  it("accepts only empty or current-schema reducer state", () => {
    const current = BrowserFeedContract.stateSchema.parse({});
    expect(current).toMatchObject({
      schemaVersion: 7,
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
      "events.iterate.com/agent/llm-response-chunk",
      { llmRequestOffset: 1, chunk: { response: "hello" } },
      true,
    );

    await harness.deliver({
      events: [requested, chunk],
      scannedAfterOffset: 0,
      scannedThroughOffset: 2,
    });

    expect(harness.composite.agentUiState?.live?.steps[0]).toMatchObject({
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

    harness.composite.clearVolatileState();
    expect(harness.composite.agentUiState).toBeNull();
    expect(harness.runner.currentState.agent.live?.steps[0]).toMatchObject({ responseText: "" });
  });

  it("seeds a cold live tail from its persisted checkpoint and skips replay overlap", async () => {
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

    // A new runtime may subscribe from a sibling processor's older checkpoint.
    // Its first live envelope can therefore overlap this feed's checkpoint.
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
