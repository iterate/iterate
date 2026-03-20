import { describe, expect, test, vi } from "vitest";
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
  const client = postgres(process.env.DATABASE_URL, { prepare: false });
  return drizzle(client, { schema, casing: "snake_case" });
};

type TestEventTypes = {
  "test:basic": { message: string };
  "test:unstable": { message: string };
  "test:fail": { message: string };
  "test:slow": { message: string };
};

const createOutboxFixture = async (opts?: { readVtSeconds?: number }) => {
  const db = getTestDb();
  const queueName = `cq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.execute(sql`select pgmq.create(${queueName}::text)`);

  const queuer = createPgmqQueuer({ queueName, readVtSeconds: opts?.readVtSeconds });
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const outboxClient = createConsumerClient<TestEventTypes, DBLike>(queuer, {
    getDb: async () => db,
    waitUntil: (promise) => {
      waitUntilPromises.push(promise);
    },
  });

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

  return {
    db,
    queuer,
    outboxClient,
    async [Symbol.asyncDispose]() {
      await Promise.allSettled(waitUntilPromises);
      await db.execute(sql`select pgmq.drop_queue(${queueName}::text)`);
      await db.$client.end({ timeout: 0 });
    },
  };
};

describe.skipIf(process.env.CI)("outbox integration", () => {
  test("basic: enqueue, process, and archive", { timeout: 30_000 }, async () => {
    await using fixture = await createOutboxFixture();
    const { db, queuer, outboxClient } = fixture;
    const slug = `basic_${Date.now()}_${Math.random()}`;
    await outboxClient.send(db, {
      name: "test:basic",
      payload: { message: slug },
    });

    // Verify event was inserted
    const event = await vi.waitUntil(async () => {
      return db.query.outboxEvent.findFirst({
        where: and(
          eq(schema.outboxEvent.name, "test:basic"),
          ilike(sql`${schema.outboxEvent.payload}::text`, `%${slug}%`),
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
      expect.arrayContaining([expect.stringContaining(`received: ${slug}`)]),
    );
  });

  test("retries: consumer fails then succeeds", { timeout: 60_000 }, async () => {
    await using fixture = await createOutboxFixture();
    const { db, queuer, outboxClient } = fixture;
    const slug = `unstable_${Date.now()}_${Math.random()}`;
    await outboxClient.send(db, {
      name: "test:unstable",
      payload: { message: slug },
    });

    const event = await vi.waitUntil(async () => {
      return db.query.outboxEvent.findFirst({
        where: and(
          eq(schema.outboxEvent.name, "test:unstable"),
          ilike(sql`${schema.outboxEvent.payload}::text`, `%${slug}%`),
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
    await using fixture = await createOutboxFixture();
    const { db, queuer, outboxClient } = fixture;
    const slug = `fail_${Date.now()}_${Math.random()}`;
    await outboxClient.send(db, {
      name: "test:fail",
      payload: { message: slug },
    });

    const event = await vi.waitUntil(async () => {
      return db.query.outboxEvent.findFirst({
        where: and(
          eq(schema.outboxEvent.name, "test:fail"),
          ilike(sql`${schema.outboxEvent.payload}::text`, `%${slug}%`),
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
    await using fixture = await createOutboxFixture();
    const { db, queuer, outboxClient } = fixture;

    const slug = `cte-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const result = await outboxClient.sendCTE({
      query: db
        .insert(schema.organization)
        .values({ name: slug, slug })
        .onConflictDoNothing()
        .returning({ id: schema.organization.id }),
      name: "test:basic",
      payload: { message: slug },
    });

    // The insert should have returned one row
    expect(result).toHaveLength(1);
    expect(result[0].id).toMatch(/^org_/);

    // An outbox event should have been created
    const outboxEvent = await db.query.outboxEvent.findFirst({
      where: and(
        eq(schema.outboxEvent.name, "test:basic"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%${slug}%`),
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
      expect.arrayContaining([expect.stringContaining(`received: ${slug}`)]),
    );
  });

  test("sendCTE: no-op insert creates no outbox event", { timeout: 30_000 }, async () => {
    await using fixture = await createOutboxFixture();
    const { db, outboxClient } = fixture;

    const slug = `cte-noop-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    // First insert succeeds
    await outboxClient.sendCTE({
      query: db
        .insert(schema.organization)
        .values({ name: slug, slug })
        .onConflictDoNothing()
        .returning({ id: schema.organization.id }),
      name: "test:basic",
      payload: { message: slug },
    });

    // Count outbox events with this slug before the duplicate attempt
    const beforeEvents = await db.query.outboxEvent.findMany({
      where: and(
        eq(schema.outboxEvent.name, "test:basic"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%${slug}%`),
      ),
    });

    // Second insert with same slug — onConflictDoNothing means 0 rows from CTE
    const dupeResult = await outboxClient.sendCTE({
      query: db
        .insert(schema.organization)
        .values({ name: slug, slug })
        .onConflictDoNothing()
        .returning({ id: schema.organization.id }),
      name: "test:basic",
      payload: { message: slug },
    });

    // No rows returned — the insert was a no-op
    expect(dupeResult).toHaveLength(0);

    // No new outbox event should have been created
    const afterEvents = await db.query.outboxEvent.findMany({
      where: and(
        eq(schema.outboxEvent.name, "test:basic"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%${slug}%`),
      ),
    });
    expect(afterEvents).toHaveLength(beforeEvents.length);
  });

  test(
    "sendCTE deduplicationKey prevents duplicate outbox events",
    { timeout: 30_000 },
    async () => {
      await using fixture = await createOutboxFixture();
      const { outboxClient } = fixture;

      const dedupKey = `dedup_${Date.now()}_${Math.random()}`;

      // First send succeeds
      const first = await outboxClient.sendCTE({
        query: [{}],
        name: "test:basic",
        deduplicationKey: dedupKey,
        payload: { message: "first" },
      });
      expect(first).toHaveLength(1);

      // Second send with same name + deduplicationKey returns empty (deduped)
      const second = await outboxClient.sendCTE({
        query: [{}],
        name: "test:basic",
        deduplicationKey: dedupKey,
        payload: { message: "second" },
      });
      expect(second).toHaveLength(0);

      // Different deduplicationKey still works
      const third = await outboxClient.sendCTE({
        query: [{}],
        name: "test:basic",
        deduplicationKey: `${dedupKey}_other`,
        payload: { message: "third" },
      });
      expect(third).toHaveLength(1);
    },
  );

  test("sendCTE select", async () => {
    await using fixture = await createOutboxFixture();
    const { db, outboxClient } = fixture;

    const orgs = [
      `select-a-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      `select-b-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    ];
    await db
      .insert(schema.organization)
      .values(orgs.map((value) => ({ name: value, slug: value })))
      .onConflictDoNothing();

    const result = await outboxClient.sendCTE({
      query: db.select().from(schema.organization).limit(1),
      name: "test:basic",
      payload: {
        message: sql`'the event id was ' || query.id`,
        ...({ hello: sql`(select 1 as one)` } as {}),
      },
    });

    expect(result[0]).toMatchObject({
      id: expect.any(String),
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
    await using fixture = await createOutboxFixture();
    const { db, outboxClient } = fixture;

    const orgs = [
      `selectm-a-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      `selectm-b-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    ];
    await db
      .insert(schema.organization)
      .values(orgs.map((value) => ({ name: value, slug: value })))
      .onConflictDoNothing();

    const result = await outboxClient.sendCTE({
      query: db.select().from(schema.organization).limit(2),
      name: "test:basic",
      payload: {
        message: sql`'the event id was ' || query.id`,
        ...({ hello: sql`(select 1 as one)` } as {}),
      },
    });

    expect(result[0]).toMatchObject({
      id: expect.any(String),
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
    await using fixture = await createOutboxFixture();
    const { db, outboxClient } = fixture;

    const slug = `cb-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const slugs = [`${slug}-a`, `${slug}-b`];
    await db.insert(schema.organization).values(slugs.map((slug) => ({ name: slug, slug })));

    const result = await outboxClient.sendCTE({
      query: db
        .select()
        .from(schema.organization)
        .where(ilike(schema.organization.slug, `${slug}%`)),
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
    await using fixture = await createOutboxFixture();
    const { db, outboxClient } = fixture;

    const slug = `camel-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await db.insert(schema.organization).values({ name: slug, slug });

    const result = await outboxClient.sendCTE({
      query: db.select().from(schema.organization).where(eq(schema.organization.slug, slug)),
      name: "test:basic",
      payload: (row) => ({
        message: row.slug,
      }),
    });

    expect([...result]).toMatchObject([{ slug, outboxEventPayload: { message: slug } }]);
  });

  test("sendCTE values", async () => {
    await using fixture = await createOutboxFixture();
    const { outboxClient } = fixture;
    const slug = `cte-select-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const result = await outboxClient.sendCTE({
      query: [
        { abc: 123, xyz: 987 },
        { abc: 456, xyz: 654 },
      ],
      name: "test:basic",
      payload: { message: slug },
    });

    expect(result[0]).toMatchObject({
      abc: 123,
      xyz: 987,

      outboxEventId: expect.any(String),
      outboxEventName: "test:basic",
      outboxEventPayload: {
        message: expect.stringContaining(slug),
      },
      outboxEventContext: expect.any(Object),
    });
  });

  test(
    "VT heartbeat: slow handler keeps message invisible so concurrent reads do not re-deliver",
    { timeout: 30_000 },
    async () => {
      // Use a short VT (2s) so we don't need to wait long.
      // The handler takes 4s — without a heartbeat the message would become
      // visible after 2s and a concurrent processQueue call would re-read it.
      const readVtSeconds = 2;
      await using fixture = await createOutboxFixture({ readVtSeconds });
      const { db, queuer, outboxClient } = fixture;

      let handlerCallCount = 0;
      outboxClient.registerConsumer({
        name: "slowHandler",
        on: "test:slow",
        handler: async (params) => {
          handlerCallCount++;
          // Sleep longer than the VT
          await new Promise((resolve) => setTimeout(resolve, 4000));
          return "slow done: " + params.payload.message;
        },
      });

      const slug = `slow_${Date.now()}_${Math.random()}`;
      await outboxClient.send(db, {
        name: "test:slow",
        payload: { message: slug },
      });

      // Start processing — the handler will take ~4s
      const processPromise = queuer.processQueue(db);

      // Wait for the VT to expire (2s + a small margin)
      await new Promise((resolve) => setTimeout(resolve, 2500));

      // Try a concurrent read — if heartbeat is working, this should find nothing
      const concurrentResult = await queuer.processQueue(db);

      // Wait for the first process to finish
      await processPromise;

      // The handler should have been called exactly once — the heartbeat kept
      // the message invisible so the concurrent processQueue got nothing.
      expect(handlerCallCount).toBe(1);
      expect(concurrentResult).toMatch(/^0 messages processed/);

      // Verify it was processed successfully
      const archive = await queuer.peekArchive(db);
      const archived = archive.find(
        (m) => m.message.consumer_name === "slowHandler" && (m.message.event_payload as any)?.message === slug,
      );
      expect(archived).toBeTruthy();
      expect(archived!.read_ct).toBe(1); // Only read once — no re-delivery
      expect(archived!.message.processing_results).toEqual([
        expect.stringContaining("slow done: " + slug),
      ]);
    },
  );
});
