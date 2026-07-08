import { expect, test } from "vitest";
import { createCachedFetch } from "./cached-fetch.ts";

// Node has no Cache API, so these exercise the in-memory dedupe lane —
// exactly what the worker gets when `caches` is unavailable.

test("dedupes repeated fetches of cacheable URLs", async () => {
  const calls: string[] = [];
  const cachedFetch = createCachedFetch({
    fetch: async (url) => {
      calls.push(url);
      return new Response(`body of ${url}`);
    },
    cacheName: "typm-test",
    shouldCache: () => true,
  });

  const first = await cachedFetch("https://cdn.jsdelivr.net/npm/zod@3.24.1/index.d.ts");
  const second = await cachedFetch("https://cdn.jsdelivr.net/npm/zod@3.24.1/index.d.ts");

  expect(await first.text()).toBe("body of https://cdn.jsdelivr.net/npm/zod@3.24.1/index.d.ts");
  expect(await second.text()).toBe("body of https://cdn.jsdelivr.net/npm/zod@3.24.1/index.d.ts");
  expect(calls).toHaveLength(1);
});

test("never caches URLs the policy excludes (range resolution moves over time)", async () => {
  const calls: string[] = [];
  const cachedFetch = createCachedFetch({
    fetch: async (url) => {
      calls.push(url);
      return Response.json({ version: "3.24.1" });
    },
    cacheName: "typm-test",
    shouldCache: (url) => !url.includes("/resolve/"),
  });

  await cachedFetch("https://data.jsdelivr.com/v1/package/resolve/npm/zod@%5E3.24.0");
  await cachedFetch("https://data.jsdelivr.com/v1/package/resolve/npm/zod@%5E3.24.0");

  expect(calls).toHaveLength(2);
});

test("does not memoize failed responses", async () => {
  let attempts = 0;
  const cachedFetch = createCachedFetch({
    fetch: async () => {
      attempts++;
      return attempts === 1 ? new Response("boom", { status: 502 }) : new Response("ok");
    },
    cacheName: "typm-test",
    shouldCache: () => true,
  });

  const failed = await cachedFetch("https://cdn.jsdelivr.net/npm/zod@3.24.1/index.d.ts");
  expect(failed.status).toBe(502);
  const retried = await cachedFetch("https://cdn.jsdelivr.net/npm/zod@3.24.1/index.d.ts");
  expect(await retried.text()).toBe("ok");
  expect(attempts).toBe(2);
});
