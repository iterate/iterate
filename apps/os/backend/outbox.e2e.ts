import { inspect } from "node:util";
import { test, expect, vi } from "vitest";
import { z } from "zod";
import { and, eq, ilike, sql } from "drizzle-orm";
import { db } from "../sdk/cli/cli-db.ts";
import { makeVitestTrpcClient } from "./utils/test-helpers/vitest/e2e/vitest-trpc-client.ts";
import * as schema from "./db/schema.ts";
import { queuer } from "./trpc/trpc.ts";

const TestEnv = z.object({
  WORKER_URL: z.url(),
  SERVICE_AUTH_TOKEN: z.string(),
});

test("outbox", { timeout: 15 * 60 * 1000 }, async () => {
  const env = TestEnv.parse({
    WORKER_URL: process.env.WORKER_URL,
    SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
  } satisfies Partial<z.input<typeof TestEnv>>);
  const workerUrl = env.WORKER_URL;

  const adminTrpc = await makeAdminTrpcClient(workerUrl, env);

  const random = String(Date.now() + Math.random());
  await adminTrpc.admin.outbox.poke.mutate({ message: "bonjour" + random }); // consumer filters by message.includes("hi")

  // vi.waitUntil vs vi.waitFor vs expect.poll:
  // vi.waitUntil: waits until truthy, bails on any errors, returns the truthy value
  // vi.waitFor: waits until successful, retries on errors, returns the result. seems useful over vi.waitUntil if you are expecting data to change rather than come into existence.
  // expect.poll: waits until successful, retries on errors, doesn't return the result but lets you fluently assert I guess. seems less useful than vi.waitFor
  await vi.waitUntil(async () => {
    return db.query.outboxEvent.findFirst({
      where: and(
        eq(schema.outboxEvent.name, "admin.outbox.poke"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%bonjour${random}%`),
      ),
    });
  });

  const queuesAfterBonjour = await Promise.all([queuer.peekQueue(db), queuer.peekArchive(db)]);
  const matchesAfterBonjour = queuesAfterBonjour.flat().filter((q) => {
    return JSON.stringify(q.message).includes(random);
  });
  expect(matchesAfterBonjour).toHaveLength(0);

  await adminTrpc.admin.outbox.poke.mutate({ message: "hi" + random }); // consumer filters by message.includes("hi")

  const hiEvent = await vi.waitUntil(async () => {
    return db.query.outboxEvent.findFirst({
      where: and(
        eq(schema.outboxEvent.name, "admin.outbox.poke"),
        ilike(sql`${schema.outboxEvent.payload}::text`, `%hi${random}%`),
      ),
    });
  });

  const queuesAfterHi = await Promise.all([queuer.peekQueue(db), queuer.peekArchive(db)]);
  const matchesAfterHi = queuesAfterHi.flat().filter((q) => {
    return JSON.stringify(q.message).includes(random);
  });
  expect(matchesAfterHi).toHaveLength(1);
  expect(matchesAfterHi).toMatchObject([
    {
      message: {
        event_name: "admin.outbox.poke",
        consumer_name: "logGreeting",
        event_id: hiEvent.id,
        event_payload: { input: { message: "hi" + random } },
      } satisfies Partial<(typeof matchesAfterHi)[number]["message"]>,
    },
  ]);
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
