import { beforeAll, describe, expect, test, vi } from "vitest";
import { sql, eq, and, ilike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { createPgmqQueuer } from "./pgmq-lib.ts";
import { createConsumerClient, type DBLike } from "./pgmq-lib.ts";

// These tests require a real database with pgmq installed.
// Run with: doppler run --config dev -- pnpm vitest run backend/outbox/outbox-integration.test.ts

const getTestDb = () => {
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
    outboxClient = createConsumerClient<TestEventTypes, DBLike>(queuer);

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
});
