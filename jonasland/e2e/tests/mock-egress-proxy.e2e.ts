import { describe, expect, test } from "vitest";
import { mockEgressProxy } from "../test-helpers/index.ts";

describe("mock egress proxy", () => {
  test.concurrent("records requests and supports waitFor", async () => {
    await using proxy = await mockEgressProxy();
    proxy.fetch = async (request) =>
      Response.json({
        path: new URL(request.url).pathname,
        method: request.method,
      });

    const handle = proxy.waitFor((request) => new URL(request.url).pathname === "/charges");
    const response = await fetch(proxy.urlFor("/charges"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 42 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/charges", method: "POST" });

    const record = await handle;
    expect(record.offset).toBe(0);
    expect(await record.request.json()).toEqual({ amount: 42 });
    expect(record.response.status).toBe(200);
    expect(proxy.records).toHaveLength(1);
  });

  test.concurrent("respondWith intercepts before fetch handler", async () => {
    await using proxy = await mockEgressProxy();
    proxy.fetch = async () => Response.json({ from: "handler" });

    const handle = proxy.waitFor((request) => new URL(request.url).pathname === "/inventory");
    handle.respondWith(Response.json({ error: "unavailable" }, { status: 503 }));

    const response = await fetch(proxy.urlFor("/inventory"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });

    const record = await handle;
    expect(record.response.status).toBe(503);
  });

  test.concurrent("iterator yields only records after iterator creation", async () => {
    await using proxy = await mockEgressProxy();
    proxy.fetch = async () => new Response("ok");

    await fetch(proxy.urlFor("/before"));

    const iterator = proxy[Symbol.asyncIterator]();
    await fetch(proxy.urlFor("/after"));

    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(new URL(next.value!.request.url).pathname).toBe("/after");

    await iterator.return?.();
  });
});
