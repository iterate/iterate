import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { createSemaphoreClient } from "@iterate-com/semaphore-contract";
import migration0001Sql from "../migrations/0001_init.sql?raw";
import type { Env } from "./env.ts";
import { handleSemaphoreRequest } from "./entry.workerd.ts";

function uniqueType() {
  return `type-${crypto.randomUUID().slice(0, 8)}`;
}

function authHeaders(token = "test-token") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

const testEnv = env as unknown as Env;
const testExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function appFetch(input: URL | string | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(String(input), init);
  return handleSemaphoreRequest(request, testEnv, testExecutionContext);
}

async function callApi<T>(params: {
  path: string;
  method?: string;
  body?: unknown;
  token?: string;
}): Promise<{ response: Response; json: T }> {
  const response = await appFetch(`https://semaphore.example${params.path}`, {
    method: params.method ?? "GET",
    headers: params.body
      ? authHeaders(params.token)
      : { authorization: `Bearer ${params.token ?? "test-token"}` },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });

  return {
    response,
    json: (await response.json()) as T,
  };
}

beforeEach(async () => {
  await resetDb(testEnv.DB);
});

describe("resources API", () => {
  test("keeps mutation endpoints authenticated", async () => {
    const response = await appFetch("https://semaphore.example/api/resources", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: uniqueType(),
        slug: "alpha",
        data: { token: "secret-a" },
      }),
    });

    expect(response.ok).toBe(false);
  });

  test("adds resources, redacts public reads, and preserves authenticated reads", async () => {
    const type = uniqueType();
    const create = await callApi<{
      type: string;
      slug: string;
      data: Record<string, unknown>;
    }>({
      path: "/api/resources",
      method: "POST",
      body: {
        type,
        slug: "alpha",
        data: { token: "secret-a" },
      },
    });

    expect(create.response.ok).toBe(true);
    expect(create.json.slug).toBe("alpha");

    const publicList = await appFetch(
      `https://semaphore.example/api/resources?type=${encodeURIComponent(type)}`,
    );
    const publicListJson = (await publicList.json()) as Array<{
      type: string;
      slug: string;
      data: Record<string, unknown>;
    }>;

    expect(publicList.ok).toBe(true);
    expect(publicListJson).toEqual([
      {
        type,
        slug: "alpha",
        data: { token: "[redacted]" },
        leaseState: "available",
        leasedUntil: null,
        lastAcquiredAt: null,
        lastReleasedAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    const list = await callApi<
      Array<{ type: string; slug: string; data: Record<string, unknown> }>
    >({
      path: `/api/resources?type=${encodeURIComponent(type)}`,
    });

    expect(list.response.ok).toBe(true);
    expect(list.json).toEqual([
      {
        type,
        slug: "alpha",
        data: { token: "secret-a" },
        leaseState: "available",
        leasedUntil: null,
        lastAcquiredAt: null,
        lastReleasedAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    const publicFound = await appFetch(
      `https://semaphore.example/api/resources/${encodeURIComponent(type)}/alpha`,
    );
    const publicFoundJson = (await publicFound.json()) as {
      slug: string;
      data: Record<string, unknown>;
    };
    expect(publicFound.ok).toBe(true);
    expect(publicFoundJson).toMatchObject({
      slug: "alpha",
      data: { token: "[redacted]" },
    });

    const found = await callApi<{ slug: string; data: Record<string, unknown> }>({
      path: `/api/resources/${encodeURIComponent(type)}/alpha`,
    });
    expect(found.response.ok).toBe(true);
    expect(found.json).toMatchObject({
      slug: "alpha",
      data: { token: "secret-a" },
    });

    const duplicate = await appFetch("https://semaphore.example/api/resources", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        type,
        slug: "alpha",
        data: { token: "secret-b" },
      }),
    });

    expect(duplicate.ok).toBe(false);
  });

  test("acquires the oldest inserted resource and enforces lease ids on release", async () => {
    const type = uniqueType();

    await callApi({
      path: "/api/resources",
      method: "POST",
      body: { type, slug: "first", data: { token: "first" } },
    });
    await callApi({
      path: "/api/resources",
      method: "POST",
      body: { type, slug: "second", data: { token: "second" } },
    });

    const acquire = await callApi<{
      type: string;
      slug: string;
      data: Record<string, unknown>;
      leaseId: string;
      expiresAt: number;
    }>({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 60_000 },
    });

    expect(acquire.response.ok).toBe(true);
    expect(acquire.json.slug).toBe("first");

    const leasedList = await callApi<
      Array<{
        slug: string;
        leaseState: string;
        leasedUntil: number | null;
        lastAcquiredAt: number | null;
      }>
    >({
      path: `/api/resources?type=${encodeURIComponent(type)}`,
    });

    expect(leasedList.json[0]).toMatchObject({
      slug: "first",
      leaseState: "leased",
      leasedUntil: expect.any(Number),
      lastAcquiredAt: expect.any(Number),
    });

    const badRelease = await callApi<{ released: boolean }>({
      path: "/api/resources/release",
      method: "POST",
      body: {
        type,
        slug: "first",
        leaseId: crypto.randomUUID(),
      },
    });

    expect(badRelease.json).toEqual({ released: false });

    const release = await callApi<{ released: boolean }>({
      path: "/api/resources/release",
      method: "POST",
      body: {
        type,
        slug: "first",
        leaseId: acquire.json.leaseId,
      },
    });

    expect(release.json).toEqual({ released: true });

    const releasedList = await callApi<
      Array<{
        slug: string;
        leaseState: string;
        leasedUntil: number | null;
        lastReleasedAt: number | null;
      }>
    >({
      path: `/api/resources?type=${encodeURIComponent(type)}`,
    });

    expect(releasedList.json[0]).toMatchObject({
      slug: "first",
      leaseState: "available",
      leasedUntil: null,
      lastReleasedAt: expect.any(Number),
    });
  });

  test("fails fast when a pool is exhausted", async () => {
    const type = uniqueType();

    await callApi({
      path: "/api/resources",
      method: "POST",
      body: { type, slug: "only", data: { token: "secret" } },
    });

    const first = await callApi({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 60_000 },
    });

    expect(first.response.ok).toBe(true);

    const second = await appFetch("https://semaphore.example/api/resources/acquire", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type, leaseMs: 60_000, waitMs: 0 }),
    });

    expect(second.ok).toBe(false);
  });

  test("wakes a waiting acquire when a resource is released", async () => {
    const type = uniqueType();

    await callApi({
      path: "/api/resources",
      method: "POST",
      body: { type, slug: "only", data: { token: "secret" } },
    });

    const first = await callApi<{
      slug: string;
      leaseId: string;
    }>({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 60_000 },
    });

    const waitingAcquire = callApi<{
      slug: string;
      leaseId: string;
    }>({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 60_000, waitMs: 500 },
    });

    await sleep(25);

    await callApi({
      path: "/api/resources/release",
      method: "POST",
      body: {
        type,
        slug: first.json.slug,
        leaseId: first.json.leaseId,
      },
    });

    const second = await waitingAcquire;
    expect(second.response.ok).toBe(true);
    expect(second.json.slug).toBe("only");
  });

  test("serves waiters in FIFO order", async () => {
    const type = uniqueType();

    await callApi({
      path: "/api/resources",
      method: "POST",
      body: { type, slug: "only", data: { token: "secret" } },
    });

    const initial = await callApi<{
      slug: string;
      leaseId: string;
    }>({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 60_000 },
    });

    const waiterOne = callApi<{
      slug: string;
      leaseId: string;
    }>({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 60_000, waitMs: 2_000 },
    });
    await sleep(100);
    const waiterTwo = callApi<{
      slug: string;
      leaseId: string;
    }>({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 60_000, waitMs: 2_000 },
    });

    await sleep(100);

    await callApi({
      path: "/api/resources/release",
      method: "POST",
      body: {
        type,
        slug: initial.json.slug,
        leaseId: initial.json.leaseId,
      },
    });

    const waiterOneResult = await waiterOne;
    expect(waiterOneResult.response.ok).toBe(true);

    await callApi({
      path: "/api/resources/release",
      method: "POST",
      body: {
        type,
        slug: waiterOneResult.json.slug,
        leaseId: waiterOneResult.json.leaseId,
      },
    });

    const waiterTwoResult = await waiterTwo;
    expect(waiterTwoResult.response.ok).toBe(true);
  });

  test("reaps expired leases on the next acquire", async () => {
    const type = uniqueType();

    await callApi({
      path: "/api/resources",
      method: "POST",
      body: { type, slug: "only", data: { token: "secret" } },
    });

    const first = await callApi({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 20 },
    });

    expect(first.response.ok).toBe(true);

    await sleep(40);

    const second = await callApi<{ slug: string }>({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 20 },
    });

    expect(second.response.ok).toBe(true);
    expect(second.json.slug).toBe("only");

    const listed = await callApi<
      Array<{ slug: string; leaseState: string; leasedUntil: number | null }>
    >({
      path: `/api/resources?type=${encodeURIComponent(type)}`,
    });

    expect(listed.json[0]).toMatchObject({
      slug: "only",
      leaseState: "leased",
      leasedUntil: expect.any(Number),
    });
  });

  test("delete removes inventory but lets the active lease finish", async () => {
    const type = uniqueType();

    await callApi({
      path: "/api/resources",
      method: "POST",
      body: { type, slug: "only", data: { token: "secret" } },
    });

    const leased = await callApi<{
      slug: string;
      leaseId: string;
    }>({
      path: "/api/resources/acquire",
      method: "POST",
      body: { type, leaseMs: 60_000 },
    });

    const deleted = await callApi<{ deleted: boolean }>({
      path: `/api/resources/${encodeURIComponent(type)}/only`,
      method: "DELETE",
    });

    expect(deleted.json).toEqual({ deleted: true });

    const list = await callApi<Array<{ slug: string }>>({
      path: `/api/resources?type=${encodeURIComponent(type)}`,
    });

    expect(list.json).toEqual([]);

    const reacquireWhileLeased = await appFetch("https://semaphore.example/api/resources", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type, slug: "only", data: { token: "new-secret" } }),
    });

    expect(reacquireWhileLeased.ok).toBe(false);

    await callApi({
      path: "/api/resources/release",
      method: "POST",
      body: {
        type,
        slug: leased.json.slug,
        leaseId: leased.json.leaseId,
      },
    });

    const readd = await callApi({
      path: "/api/resources",
      method: "POST",
      body: { type, slug: "only", data: { token: "new-secret" } },
    });

    expect(readd.response.ok).toBe(true);
  });
});

describe("contract client", () => {
  test("calls the worker through createSemaphoreClient with a custom fetch", async () => {
    const client = createSemaphoreClient({
      apiKey: "test-token",
      fetch: appFetch,
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
