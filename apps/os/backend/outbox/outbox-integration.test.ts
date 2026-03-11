import { beforeAll, describe, expect, test, vi } from "vitest";
import { sql, eq, and, ilike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { resolveLocalDockerPostgresPort } from "../../scripts/local-docker-postgres-port.ts";
import { createPgmqQueuer } from "./pgmq-lib.ts";
import { createConsumerClient, type DBLike } from "./pgmq-lib.ts";

// These tests require a real database with pgmq installed.
// Run with: doppler run --config dev -- pnpm vitest run backend/outbox/outbox-integration.test.ts

const getTestDb = () => {
  process.env.DATABASE_URL ||= `postgres://postgres:postgres@localhost:${resolveLocalDockerPostgresPort()}/os`;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required for integration tests. Run with: doppler run --config dev -- pnpm vitest run ...",
    );
  }
  const client = postgres(process.env.DATABASE_URL, { prepare: false });
  return drizzle(client, { schema, casing: "snake_case" });
};

describe("outbox integration", () => {
  let db: ReturnType<typeof getTestDb>;
  let queuer: ReturnType<typeof createPgmqQueuer>;
  let outboxClient: ReturnType<typeof createConsumerClient<TestEventTypes, DBLike>>;

  type TestEventTypes = {
    "test:basic": { message: string };
    "test:unstable": { message: string };
    "test:fail": { message: string };
  };

  beforeAll(() => {
    try {
      db = getTestDb();
    } catch {
      // Skip all tests if no DATABASE_URL
      return;
    }

    queuer = createPgmqQueuer({ queueName: "consumer_job_queue" });

    // Register test consumers
    outboxClient = createConsumerClient<TestEventTypes, DBLike>(queuer, { getDb: () => db });

    outboxClient.registerConsumer({
      name: "logBasic",
      on: "test:basic",
      handler: (params) => {
        return "received: " + params.payload.message;
      },
    });

    outboxClient.registerConsumer({
      name: "unstableHandler",
      on: "test:unstable",
      handler: (params) => {
        if (params.job.attempt <= 2) {
          throw new Error(`[test] Attempt ${params.job.attempt} failed`);
        }
        return "third time lucky";
      },
    });

    outboxClient.registerConsumer({
      name: "alwaysFails",
      on: "test:fail",
      retry: (job) => {
        if (job.read_ct <= 3) return { retry: true, reason: "keep trying", delay: "0s" };
        return { retry: false, reason: "giving up" };
      },
      handler: () => {
        throw new Error("[test] always fails");
      },
    });
  });

  test("basic: enqueue, process, and archive", { timeout: 30_000 }, async () => {
    if (!db) return; // skip if no DB

    const secret = `basic_${Date.now()}_${Math.random()}`;
    await outboxClient.send({ transaction: db, parent: db }, "test:basic", { message: secret });

    // Verify event was inserted
    const event = await vi.waitUntil(async () => {
      return db.query.outboxEvent.findFirst({
        where: and(
          eq(schema.outboxEvent.name, "test:basic"),
          ilike(sql`${schema.outboxEvent.payload}::text`, `%${secret}%`),
        ),
      });
    });
    expect(event).toBeTruthy();

    // Process the queue
    await queuer.processQueue(db);

    // Check the archive
    const archive = await queuer.peekArchive(db);
    const archived = archive.find((m) => m.message.event_id === event!.id);
    expect(archived).toBeTruthy();
    expect(archived!.message.consumer_name).toBe("logBasic");
    expect(archived!.message.processing_results).toEqual(
      expect.arrayContaining([expect.stringContaining(`received: ${secret}`)]),
    );
  });

  test("retries: consumer fails then succeeds", { timeout: 60_000 }, async () => {
    if (!db) return;

    const secret = `unstable_${Date.now()}_${Math.random()}`;
    await outboxClient.send({ transaction: db, parent: db }, "test:unstable", { message: secret });

    const event = await vi.waitUntil(async () => {
      return db.query.outboxEvent.findFirst({
        where: and(
          eq(schema.outboxEvent.name, "test:unstable"),
          ilike(sql`${schema.outboxEvent.payload}::text`, `%${secret}%`),
        ),
      });
    });
    expect(event).toBeTruthy();

    // Process multiple times until archived
    const archived = await vi.waitUntil(
      async () => {
        await queuer.processQueue(db);
        const arch = await queuer.peekArchive(db);
        return arch.find((m) => m.message.event_id === event!.id);
      },
      { timeout: 30_000, interval: 1000 },
    );

    expect(archived).toBeTruthy();
    expect(archived!.read_ct).toBe(3);
    expect(archived!.message.processing_results).toEqual([
      expect.stringMatching(/#1 error: .* Attempt 1 failed/),
      expect.stringMatching(/#2 error: .* Attempt 2 failed/),
      expect.stringMatching(/#3 success: third time lucky/),
    ]);
  });

  test("DLQ: consumer always fails, eventually gives up", { timeout: 60_000 }, async () => {
    if (!db) return;

    const secret = `fail_${Date.now()}_${Math.random()}`;
    await outboxClient.send({ transaction: db, parent: db }, "test:fail", { message: secret });

    const event = await vi.waitUntil(async () => {
      return db.query.outboxEvent.findFirst({
        where: and(
          eq(schema.outboxEvent.name, "test:fail"),
          ilike(sql`${schema.outboxEvent.payload}::text`, `%${secret}%`),
        ),
      });
    });
    expect(event).toBeTruthy();

    // Process multiple times until archived with failed status
    const archived = await vi.waitUntil(
      async () => {
        await queuer.processQueue(db);
        const arch = await queuer.peekArchive(db);
        return arch.find((m) => m.message.event_id === event!.id);
      },
      { timeout: 30_000, interval: 1000 },
    );

    expect(archived).toBeTruthy();
    expect(archived!.read_ct).toBe(4); // 3 retries + 1 final attempt
    expect(archived!.message.status).toBe("failed");
    expect(archived!.message.processing_results).toHaveLength(4);
  });

  test("sendCTE: atomically inserts row and outbox event", { timeout: 30_000 }, async () => {
    if (!db) return;

    const secret = `cte_${Date.now()}_${Math.random()}`;
    const externalId = `test-delivery-${secret}`;

    const result = await outboxClient.sendCTE({
      query: db
        .insert(schema.event)
        .values({
          type: "test:basic",
          payload: { message: secret },
          externalId,
        })
        .onConflictDoNothing({
          target: [schema.event.type, schema.event.externalId],
        })
        .returning({ id: schema.event.id }),
      name: "test:basic",
      payload: { message: secret },
    });

    // The insert should have returned one row
    expect(result).toHaveLength(1);
    expect(result[0].id).toMatch(/^evt_/);

    // An outbox event should have been created
    const outboxEvent = await db.query.outboxEvent.findFirst({
      where: and(
        eq(schema.outboxEvent.name, "test:basic"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%${secret}%`),
      ),
    });
    expect(outboxEvent).toBeTruthy();

    // Process the queue — the consumer should pick it up
    await queuer.processQueue(db);

    const archived = await queuer.peekArchive(db);
    const match = archived.find((m) => m.message.event_id === outboxEvent!.id);
    expect(match).toBeTruthy();
    expect(match!.message.consumer_name).toBe("logBasic");
    expect(match!.message.processing_results).toEqual(
      expect.arrayContaining([expect.stringContaining(`received: ${secret}`)]),
    );
  });

  test("sendCTE: no-op insert creates no outbox event", { timeout: 30_000 }, async () => {
    if (!db) return;

    const secret = `cte_noop_${Date.now()}_${Math.random()}`;
    const externalId = `test-delivery-${secret}`;

    // First insert succeeds
    await outboxClient.sendCTE({
      query: db
        .insert(schema.event)
        .values({
          type: "test:basic",
          payload: { message: secret },
          externalId,
        })
        .onConflictDoNothing({
          target: [schema.event.type, schema.event.externalId],
        })
        .returning({ id: schema.event.id }),
      name: "test:basic",
      payload: { message: secret },
    });

    // Count outbox events with this secret before the duplicate attempt
    const beforeEvents = await db.query.outboxEvent.findMany({
      where: and(
        eq(schema.outboxEvent.name, "test:basic"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%${secret}%`),
      ),
    });

    // Second insert with same externalId — onConflictDoNothing means 0 rows from CTE
    const dupeResult = await outboxClient.sendCTE({
      query: db
        .insert(schema.event)
        .values({
          type: "test:basic",
          payload: { message: secret },
          externalId,
        })
        .onConflictDoNothing({
          target: [schema.event.type, schema.event.externalId],
        })
        .returning({ id: schema.event.id }),
      name: "test:basic",
      payload: { message: secret },
    });

    // No rows returned — the insert was a no-op
    expect(dupeResult).toHaveLength(0);

    // No new outbox event should have been created
    const afterEvents = await db.query.outboxEvent.findMany({
      where: and(
        eq(schema.outboxEvent.name, "test:basic"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%${secret}%`),
      ),
    });
    expect(afterEvents).toHaveLength(beforeEvents.length);
  });

  test("sendCTE select", async () => {
    const db = getTestDb();

    const result = await outboxClient.sendCTE({
      query: db.select().from(schema.event).limit(1),
      name: "test:basic",
      payload: {
        message: sql`'the event id was ' || query.id`,
        ...({ hello: sql`(select 1 as one)` } as {}),
      },
    });

    expect(result[0]).toMatchObject({
      id: expect.any(String),
      payload: expect.any(Object),
      createdAt: expect.any(Date),

      outboxEventId: expect.any(String),
      outboxEventName: "test:basic",
      outboxEventPayload: {
        message: `the event id was ${result[0].id}`,
        hello: 1,
      },
      outboxEventContext: expect.any(Object),
    });
  });

  test("sendCTE select multiple", async () => {
    const db = getTestDb();

    const result = await outboxClient.sendCTE({
      query: db.select().from(schema.event).limit(2),
      name: "test:basic",
      payload: {
        message: sql`'the event id was ' || query.id`,
        ...({ hello: sql`(select 1 as one)` } as {}),
      },
    });

    expect(result[0]).toMatchObject({
      id: expect.any(String),
      payload: expect.any(Object),
      createdAt: expect.any(Date),

      outboxEventId: expect.any(String),
      outboxEventName: "test:basic",
      outboxEventPayload: {
        message: `the event id was ${result[0].id}`,
        hello: 1,
      },
      outboxEventContext: expect.any(Object),
    });

    expect(result).toHaveLength(2);
  });

  test("sendCTE payload callback: derives payload from query result in SQL", async () => {
    const db = getTestDb();

    const secret = `cb_${Date.now()}_${Math.random()}`;
    const externalIds = [`${secret}-a`, `${secret}-b`];
    await db
      .insert(schema.event)
      .values(externalIds.map((externalId) => ({ type: "test:basic", payload: {}, externalId })));

    const result = await outboxClient.sendCTE({
      query: db
        .select()
        .from(schema.event)
        .where(ilike(schema.event.externalId, `${secret}%`)),
      name: "test:basic",
      payload: (row) => ({
        message: row.id,
      }),
    });

    expect([...result]).toMatchObject([
      { id: expect.any(String), outboxEventPayload: { message: result[0].id } },
      { id: expect.any(String), outboxEventPayload: { message: result[1].id } },
    ]);
    expect(result[0].id).not.toBe(result[1].id);
  });

  test("sendCTE payload callback: camelCase props become snake_case SQL columns", async () => {
    const db = getTestDb();

    const secret = `camel_${Date.now()}_${Math.random()}`;
    await db.insert(schema.event).values({ type: "test:basic", payload: {}, externalId: secret });

    const result = await outboxClient.sendCTE({
      query: db.select().from(schema.event).where(eq(schema.event.externalId, secret)),
      name: "test:basic",
      payload: (row) => ({
        message: row.externalId,
      }),
    });

    expect([...result]).toMatchObject([
      { externalId: secret, outboxEventPayload: { message: secret } },
    ]);
  });

  test("sendCTE values", async () => {
    const secret = `cte_select_${Date.now()}_${Math.random()}`;

    const result = await outboxClient.sendCTE({
      query: [
        { abc: 123, xyz: 987 },
        { abc: 456, xyz: 654 },
      ],
      name: "test:basic",
      payload: { message: secret },
    });

    expect(result[0]).toMatchObject({
      abc: 123,
      xyz: 987,

      outboxEventId: expect.any(String),
      outboxEventName: "test:basic",
      outboxEventPayload: {
        message: expect.stringContaining(secret),
      },
      outboxEventContext: expect.any(Object),
    });
  });
});
