import migration0001Sql from "./migrations/0001_init.sql?raw";
import { createSemaphoreClient } from "@iterate-com/semaphore-contract";
import type { RawSemaphoreEnv } from "./server.ts";

function uniqueType() {
  return `type-${crypto.randomUUID().slice(0, 8)}`;
}

function authHeaders(token = "test-token") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function resetDb(db: D1Database) {
  await db.prepare("DROP TABLE IF EXISTS resources").run();

  for (const statement of migration0001Sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((value: string) => value.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

async function callProcedure<T>(params: {
  env: RawSemaphoreEnv;
  name: string;
  input: unknown;
  token?: string;
}): Promise<{ response: Response; payload: { json?: T } }> {
  const { app } = await import("./server.ts");
  const response = await app.fetch(
    new Request(`https://semaphore.example/api/orpc/${params.name}`, {
      method: "POST",
      headers: authHeaders(params.token),
      body: JSON.stringify({ json: params.input }),
    }),
    params.env as never,
  );

  return {
    response,
    payload: (await response.json()) as { json?: T },
  };
}

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";

const testEnv = env as unknown as RawSemaphoreEnv;

beforeEach(async () => {
  await resetDb(testEnv.DB);
});

describe("resources API", () => {
  test("rejects unauthorized requests", async () => {
    const { response } = await callProcedure({
      env: testEnv,
      name: "resources/list",
      input: {},
      token: "wrong-token",
    });

    expect(response.ok).toBe(false);
  });

  test("adds, lists, and rejects duplicates", async () => {
    const type = uniqueType();
    const create = await callProcedure<{
      type: string;
      slug: string;
      data: Record<string, unknown>;
    }>({
      env: testEnv,
      name: "resources/add",
      input: {
        type,
        slug: "alpha",
        data: { token: "secret-a" },
      },
    });

    expect(create.response.ok).toBe(true);
    expect(create.payload.json?.slug).toBe("alpha");

    const list = await callProcedure<
      Array<{ type: string; slug: string; data: Record<string, unknown> }>
    >({
      env: testEnv,
      name: "resources/list",
      input: { type },
    });

    expect(list.response.ok).toBe(true);
    expect(list.payload.json).toEqual([
      {
        type,
        slug: "alpha",
        data: { token: "secret-a" },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    const duplicate = await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: {
        type,
        slug: "alpha",
        data: { token: "secret-b" },
      },
    });

    expect(duplicate.response.ok).toBe(false);
  });

  test("acquires the oldest inserted resource and enforces lease ids on release", async () => {
    const type = uniqueType();

    await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "first", data: { token: "first" } },
    });
    await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "second", data: { token: "second" } },
    });

    const acquire = await callProcedure<{
      type: string;
      slug: string;
      data: Record<string, unknown>;
      leaseId: string;
      expiresAt: number;
    }>({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000 },
    });

    expect(acquire.response.ok).toBe(true);
    expect(acquire.payload.json?.slug).toBe("first");

    const badRelease = await callProcedure<{ released: boolean }>({
      env: testEnv,
      name: "resources/release",
      input: {
        type,
        slug: "first",
        leaseId: crypto.randomUUID(),
      },
    });

    expect(badRelease.payload.json).toEqual({ released: false });

    const release = await callProcedure<{ released: boolean }>({
      env: testEnv,
      name: "resources/release",
      input: {
        type,
        slug: "first",
        leaseId: acquire.payload.json?.leaseId,
      },
    });

    expect(release.payload.json).toEqual({ released: true });
  });

  test("fails fast when a pool is exhausted", async () => {
    const type = uniqueType();

    await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "only", data: { token: "secret" } },
    });

    const first = await callProcedure({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000 },
    });

    expect(first.response.ok).toBe(true);

    const second = await callProcedure({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000, waitMs: 0 },
    });

    expect(second.response.ok).toBe(false);
  });

  test("wakes a waiting acquire when a resource is released", async () => {
    const type = uniqueType();

    await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "only", data: { token: "secret" } },
    });

    const first = await callProcedure<{
      slug: string;
      leaseId: string;
    }>({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000 },
    });

    const waitingAcquire = callProcedure<{
      slug: string;
      leaseId: string;
    }>({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000, waitMs: 500 },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    await callProcedure({
      env: testEnv,
      name: "resources/release",
      input: {
        type,
        slug: first.payload.json?.slug,
        leaseId: first.payload.json?.leaseId,
      },
    });

    const second = await waitingAcquire;
    expect(second.response.ok).toBe(true);
    expect(second.payload.json?.slug).toBe("only");
  });

  test("serves waiters in FIFO order", async () => {
    const type = uniqueType();

    await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "only", data: { token: "secret" } },
    });

    const initial = await callProcedure<{
      slug: string;
      leaseId: string;
    }>({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000 },
    });

    const waiterOne = callProcedure<{
      slug: string;
      leaseId: string;
    }>({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000, waitMs: 2_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const waiterTwo = callProcedure<{
      slug: string;
      leaseId: string;
    }>({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000, waitMs: 2_000 },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    await callProcedure({
      env: testEnv,
      name: "resources/release",
      input: {
        type,
        slug: initial.payload.json?.slug,
        leaseId: initial.payload.json?.leaseId,
      },
    });

    const waiterOneResult = await waiterOne;
    expect(waiterOneResult.response.ok).toBe(true);

    await callProcedure({
      env: testEnv,
      name: "resources/release",
      input: {
        type,
        slug: waiterOneResult.payload.json?.slug,
        leaseId: waiterOneResult.payload.json?.leaseId,
      },
    });

    const waiterTwoResult = await waiterTwo;
    expect(waiterTwoResult.response.ok).toBe(true);
  });

  test("reaps expired leases on the next acquire", async () => {
    const type = uniqueType();

    await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "only", data: { token: "secret" } },
    });

    const first = await callProcedure({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 20 },
    });

    expect(first.response.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 40));

    const second = await callProcedure<{
      slug: string;
    }>({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 20 },
    });

    expect(second.response.ok).toBe(true);
    expect(second.payload.json?.slug).toBe("only");
  });

  test("delete removes inventory but lets the active lease finish", async () => {
    const type = uniqueType();

    await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "only", data: { token: "secret" } },
    });

    const leased = await callProcedure<{
      slug: string;
      leaseId: string;
    }>({
      env: testEnv,
      name: "resources/acquire",
      input: { type, leaseMs: 60_000 },
    });

    const deleted = await callProcedure<{ deleted: boolean }>({
      env: testEnv,
      name: "resources/delete",
      input: { type, slug: "only" },
    });

    expect(deleted.payload.json).toEqual({ deleted: true });

    const list = await callProcedure<Array<{ slug: string }>>({
      env: testEnv,
      name: "resources/list",
      input: { type },
    });

    expect(list.payload.json).toEqual([]);

    const reacquireWhileLeased = await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "only", data: { token: "new-secret" } },
    });

    expect(reacquireWhileLeased.response.ok).toBe(false);

    await callProcedure({
      env: testEnv,
      name: "resources/release",
      input: {
        type,
        slug: leased.payload.json?.slug,
        leaseId: leased.payload.json?.leaseId,
      },
    });

    const readd = await callProcedure({
      env: testEnv,
      name: "resources/add",
      input: { type, slug: "only", data: { token: "new-secret" } },
    });

    expect(readd.response.ok).toBe(true);
  });
});

describe("contract client", () => {
  test("calls the worker through createSemaphoreClient with a custom fetch", async () => {
    const { app } = await import("./server.ts");
    const client = createSemaphoreClient({
      apiKey: "test-token",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        return app.fetch(request, testEnv as never);
      },
    });

    const type = uniqueType();
    const created = await client.resources.add({
      type,
      slug: "client-alpha",
      data: { token: "secret-client" },
    });

    expect(created.slug).toBe("client-alpha");

    const listed = await client.resources.list({ type });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.data).toEqual({ token: "secret-client" });
  });
});
