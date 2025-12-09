import { inspect } from "node:util";
import { test, expect, vi } from "vitest";
import { z } from "zod";
import { and, eq, ilike, sql } from "drizzle-orm";
import { db } from "../../sdk/cli/cli-db.ts";
import { makeVitestTrpcClient } from "../utils/test-helpers/vitest/e2e/vitest-trpc-client.ts";
import * as schema from "../db/schema.ts";

const TestEnv = z.object({
  WORKER_URL: z.url(),
  SERVICE_AUTH_TOKEN: z.string(),
});

test("outbox basic", { timeout: 15 * 60 * 1000 }, async () => {
  const env = TestEnv.parse({
    WORKER_URL: process.env.WORKER_URL,
    SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
  } satisfies Partial<z.input<typeof TestEnv>>);
  const workerUrl = env.WORKER_URL;

  const adminTrpc = await makeAdminTrpcClient(workerUrl, env);

  const random = String(Date.now() + Math.random());
  await adminTrpc.admin.outbox.poke.mutate({ message: "bonjour" + random }); // consumer filters by message.includes("hi")

  // COMPARISON: vi.waitUntil vs vi.waitFor vs expect.poll:
  // vi.waitUntil: waits until truthy, bails on any errors, returns the truthy value. Seems best because usually if you're "waiting" you don't want to tolerate system exceptions. vitest doesn't know how to differentiate between assertions and system exceptions, so when you use this you'll fail fast if something actually goes wrong.
  // vi.waitFor: waits until successful, retries on errors, returns the result. Could be useful over vi.waitUntil if you are expecting data to change rather than come into existence, but will fail slowly if the system throws errors that *should* fail the test. They'll just be retried.
  // expect.poll: waits until successful, retries on errors, doesn't return the result but lets you fluently assert I guess. seems less useful than vi.waitFor.
  await vi.waitUntil(async () => {
    return db.query.outboxEvent.findFirst({
      where: and(
        eq(schema.outboxEvent.name, "trpc:admin.outbox.poke"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%bonjour${random}%`),
      ),
    });
  });

  const queuesAfterBonjour = await Promise.all([
    adminTrpc.admin.outbox.peek.query(),
    adminTrpc.admin.outbox.peekArchive.query(),
  ]);
  const matchesAfterBonjour = queuesAfterBonjour.flat().filter((q) => {
    return JSON.stringify(q.message).includes(random);
  });
  expect(matchesAfterBonjour).toHaveLength(0);

  await adminTrpc.admin.outbox.poke.mutate({ message: "hi" + random }); // consumer filters by message.includes("hi")

  const hiEvent = await vi.waitUntil(async () => {
    return db.query.outboxEvent.findFirst({
      where: and(
        eq(schema.outboxEvent.name, "trpc:admin.outbox.poke"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%hi${random}%`),
      ),
    });
  });

  const arvhiedHi = await vi.waitUntil(
    async () => {
      const archive = await adminTrpc.admin.outbox.peekArchive.query();
      const result = archive.find((m) => m.message.event_id === hiEvent.id);
      if (!result) await adminTrpc.admin.outbox.process.mutate();
      return result;
    },
    { timeout: 10_000, interval: 2000 },
  );

  expect(arvhiedHi).toMatchObject({
    message: {
      event_name: "trpc:admin.outbox.poke",
      consumer_name: "logGreeting",
      event_id: hiEvent.id,
      event_payload: { input: { message: "hi" + random } },
      processing_results: [expect.stringMatching(/#1 success: logged it/)],
    } satisfies Partial<(typeof arvhiedHi)["message"]>,
  });
});

test("outbox retries", { timeout: 60_000 }, async () => {
  const env = TestEnv.parse({
    WORKER_URL: process.env.WORKER_URL,
    SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
  } satisfies Partial<z.input<typeof TestEnv>>);
  const workerUrl = env.WORKER_URL;

  const adminTrpc = await makeAdminTrpcClient(workerUrl, env);

  const secret = String(Date.now() + Math.random());
  await adminTrpc.admin.outbox.poke.mutate({ message: "unstable" + secret }); // consumer filters by message.includes("unstable")

  const event = await vi.waitUntil(async () => {
    return db.query.outboxEvent.findFirst({
      where: and(
        eq(schema.outboxEvent.name, "trpc:admin.outbox.poke"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%unstable${secret}%`),
      ),
    });
  });

  const result = await vi.waitUntil(
    async () => {
      await adminTrpc.admin.outbox.process.mutate();
      const archive = await adminTrpc.admin.outbox.peekArchive.query();
      return archive.find((m) => m.message.event_id === event.id);
    },
    { timeout: 60_000, interval: 2000 },
  );

  expect(result).toMatchObject({
    enqueued_at: expect.any(String),
    message: {
      consumer_name: "unstableConsumer",
      event_id: event.id,
      event_name: "trpc:admin.outbox.poke",
      event_payload: {
        input: {
          message: expect.stringContaining(secret),
        },
        output: {
          dbtime: expect.any(String),
          reply: "You used 1 words, well done.",
        },
      },
      processing_results: [
        expect.stringMatching(/#1 error: .* Attempt 1 failed/),
        expect.stringMatching(/#2 error: .* Attempt 2 failed/),
        expect.stringMatching(/#3 success: third time lucky/),
      ],
    },
    msg_id: expect.any(String),
    read_ct: 3,
    vt: expect.any(String),
  });
});

test("outbox give up (DLQ-like behaviour)", { timeout: 2 * 60_000 }, async () => {
  const env = TestEnv.parse({
    WORKER_URL: process.env.WORKER_URL,
    SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
  } satisfies Partial<z.input<typeof TestEnv>>);
  const workerUrl = env.WORKER_URL;

  const adminTrpc = await makeAdminTrpcClient(workerUrl, env);

  const secret = String(Date.now() + Math.random());
  await adminTrpc.admin.outbox.poke.mutate({ message: "fail" + secret }); // consumer filters by message.includes("unstable")

  const event = await vi.waitUntil(async () => {
    return db.query.outboxEvent.findFirst({
      where: and(
        eq(schema.outboxEvent.name, "trpc:admin.outbox.poke"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%fail${secret}%`),
      ),
    });
  });

  const result = await vi.waitUntil(
    async () => {
      await adminTrpc.admin.outbox.process.mutate();
      const archive = await adminTrpc.admin.outbox.peekArchive.query();
      return archive.find((m) => m.message.event_id === event.id);
    },
    { timeout: 60_000, interval: 2000 },
  );

  expect(result).toMatchObject({
    enqueued_at: expect.any(String),
    message: {
      consumer_name: "badConsumer",
      event_id: event.id,
      event_name: "trpc:admin.outbox.poke",
      event_payload: {
        input: {
          message: expect.stringContaining(secret),
        },
        output: {
          dbtime: expect.any(String),
          reply: "You used 1 words, well done.",
        },
      },
      processing_results: [
        expect.stringMatching(/#1 error: .* Attempt 1 failed/),
        expect.stringMatching(/#2 error: .* Attempt 2 failed/),
        expect.stringMatching(/#3 error: .* Attempt 3 failed/),
        expect.stringMatching(/#4 error: .* Attempt 4 failed/),
        expect.stringMatching(/#5 error: .* Attempt 5 failed/),
        expect.stringMatching(/#6 error: .* Attempt 6 failed/),
      ],
    },
    msg_id: expect.any(String),
    read_ct: 6,
    vt: expect.any(String),
  });
});

async function makeAdminTrpcClient(
  workerUrl: string,
  env: { WORKER_URL: string; SERVICE_AUTH_TOKEN: string },
) {
  // Use service auth to get session for super user
  const serviceAuthResponse = await fetch(`${workerUrl}/api/auth/service-auth/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serviceAuthToken: env.SERVICE_AUTH_TOKEN }),
  });

  if (!serviceAuthResponse.ok) {
    const error = await serviceAuthResponse.text();
    const headers = inspect(serviceAuthResponse.headers);
    throw new Error(
      `Failed to authenticate with service auth: ${error}. Status ${serviceAuthResponse.status}. Headers: ${headers}`,
    );
  }

  const sessionCookies = serviceAuthResponse.headers.get("set-cookie");
  if (!sessionCookies) {
    const text = await serviceAuthResponse.text();
    const headers = inspect(serviceAuthResponse.headers);
    throw new Error(
      `Failed to get session cookies from service auth. Response: ${text}. Status ${serviceAuthResponse.status}. Headers: ${headers}`,
    );
  }

  return makeVitestTrpcClient({
    url: `${workerUrl}/api/trpc`,
    headers: { cookie: sessionCookies },
  });
}
