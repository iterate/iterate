import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { HttpResponse, http, passthrough } from "msw";
import type { LifeCycleEventsMap } from "msw";
import { createNativeMswServer, type NativeMswServer } from "../src/index.ts";

const activeServers = new Set<NativeMswServer>();
const lifecycleEventNames = [
  "request:start",
  "request:match",
  "request:unhandled",
  "request:end",
  "response:mocked",
  "response:bypass",
] as const;

type LifecycleEventName = (typeof lifecycleEventNames)[number];
type LifecycleEventCall = [LifecycleEventName, { request: Request; requestId: string }];

async function listen(server: NativeMswServer): Promise<{ baseUrl: string; port: number }> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  activeServers.add(server);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
  };
}

async function close(server: NativeMswServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  activeServers.delete(server);
}

function observeLifecycle(server: NativeMswServer): Array<LifecycleEventCall> {
  const calls: Array<LifecycleEventCall> = [];
  for (const eventName of lifecycleEventNames) {
    server.events.on(eventName, (args) => {
      calls.push([eventName, args]);
    });
  }
  return calls;
}

function eventNames(calls: Array<LifecycleEventCall>): Array<LifecycleEventName> {
  return calls.map((call) => call[0]);
}

async function rawRequest(params: {
  port: number;
  hostHeader: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const { port, hostHeader, path, method = "GET", headers = {}, body } = params;
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        host: hostHeader,
        ...headers,
      },
    });

    req.on("error", reject);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    if (body) req.write(body);
    req.end();
  });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of activeServers) {
    await close(server);
  }
});

describe("native server e2e parity with MSW handleRequest tests", () => {
  test('returns 404 for "accept: msw/passthrough" and does not emit request:unhandled', async () => {
    const onUnhandledRequest = vi.fn();
    const server = createNativeMswServer({ onUnhandledRequest });
    const { baseUrl } = await listen(server);
    const events = observeLifecycle(server);

    const response = await fetch(`${baseUrl}/user`, {
      headers: {
        accept: "msw/passthrough",
      },
    });

    expect(response.status).toBe(404);
    expect(onUnhandledRequest).not.toHaveBeenCalled();
    expect(eventNames(events)).toEqual(["request:start", "request:end"]);
  });

  test('does not bypass a request with "accept: msw/*" arbitrary value', async () => {
    const onUnhandledRequest = vi.fn();
    const server = createNativeMswServer(
      { onUnhandledRequest },
      http.get("/user", () => {
        return HttpResponse.text("hello world");
      }),
    );
    const { baseUrl } = await listen(server);
    const events = observeLifecycle(server);

    const response = await fetch(`${baseUrl}/user`, {
      headers: {
        accept: "msw/invalid",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("hello world");
    expect(onUnhandledRequest).not.toHaveBeenCalled();
    expect(eventNames(events)).toEqual([
      "request:start",
      "request:match",
      "request:end",
      "response:mocked",
    ]);
  });

  test("reports request as unhandled when no handlers match", async () => {
    const onUnhandledRequest = vi.fn();
    const server = createNativeMswServer({ onUnhandledRequest });
    const { baseUrl } = await listen(server);
    const events = observeLifecycle(server);

    const response = await fetch(`${baseUrl}/user`);
    expect(response.status).toBe(404);

    expect(eventNames(events)).toEqual(["request:start", "request:unhandled", "request:end"]);
    expect(onUnhandledRequest).toHaveBeenCalledTimes(1);
  });

  test("returns 404 when a matching handler returns no response", async () => {
    const onUnhandledRequest = vi.fn();
    const server = createNativeMswServer(
      { onUnhandledRequest },
      http.get("/user", () => {
        return;
      }),
    );
    const { baseUrl } = await listen(server);
    const events = observeLifecycle(server);

    const response = await fetch(`${baseUrl}/user`);
    expect(response.status).toBe(404);
    expect(eventNames(events)).toEqual(["request:start", "request:end"]);
    expect(onUnhandledRequest).not.toHaveBeenCalled();
  });

  test("returns mocked response on a matching handler", async () => {
    const server = createNativeMswServer(
      http.get("/user", () => {
        return HttpResponse.json({ firstName: "John" });
      }),
    );
    const { baseUrl } = await listen(server);
    const events = observeLifecycle(server);

    const response = await fetch(`${baseUrl}/user`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ firstName: "John" });
    expect(eventNames(events)).toEqual([
      "request:start",
      "request:match",
      "request:end",
      "response:mocked",
    ]);
  });

  test("returns 404 without warning on passthrough()", async () => {
    const onUnhandledRequest = vi.fn();
    const server = createNativeMswServer(
      { onUnhandledRequest },
      http.get("/user", () => {
        return passthrough();
      }),
    );
    const { baseUrl } = await listen(server);
    const events = observeLifecycle(server);

    const response = await fetch(`${baseUrl}/user`);
    expect(response.status).toBe(404);
    expect(eventNames(events)).toEqual(["request:start", "request:end"]);
    expect(onUnhandledRequest).not.toHaveBeenCalled();
  });

  test("passes requestId to resolver", async () => {
    let seenRequestId: string | null = null;
    const server = createNativeMswServer(
      http.get("/user", ({ requestId }) => {
        seenRequestId = requestId;
        return HttpResponse.text("ok");
      }),
    );
    const { baseUrl } = await listen(server);

    const response = await fetch(`${baseUrl}/user`);
    expect(response.status).toBe(200);
    expect(seenRequestId).toBeTruthy();
    expect(String(seenRequestId).startsWith("native-")).toBe(true);
  });

  test("marks first matching one-time handler as used", async () => {
    const oneTimeHandler = http.get(
      "/resource",
      () => {
        return HttpResponse.text("One-time");
      },
      { once: true },
    );
    const anotherHandler = http.get("/resource", () => {
      return HttpResponse.text("Another");
    });

    const server = createNativeMswServer(oneTimeHandler, anotherHandler);
    const { baseUrl } = await listen(server);

    const firstResponse = await fetch(`${baseUrl}/resource`);
    expect(await firstResponse.text()).toBe("One-time");
    expect(oneTimeHandler.isUsed).toBe(true);
    expect(anotherHandler.isUsed).toBe(false);

    const secondResponse = await fetch(`${baseUrl}/resource`);
    expect(await secondResponse.text()).toBe("Another");
    expect(oneTimeHandler.isUsed).toBe(true);
    expect(anotherHandler.isUsed).toBe(true);
  });

  test("does not mark non-matching one-time handlers as used", async () => {
    const oneTimeHandler = http.get(
      "/resource",
      () => {
        return HttpResponse.text("One-time");
      },
      { once: true },
    );
    const anotherHandler = http.get(
      "/another",
      () => {
        return HttpResponse.text("Another");
      },
      { once: true },
    );

    const server = createNativeMswServer(oneTimeHandler, anotherHandler);
    const { baseUrl } = await listen(server);

    const first = await fetch(`${baseUrl}/another`);
    expect(await first.text()).toBe("Another");
    expect(oneTimeHandler.isUsed).toBe(false);
    expect(anotherHandler.isUsed).toBe(true);

    const second = await fetch(`${baseUrl}/resource`);
    expect(await second.text()).toBe("One-time");
    expect(oneTimeHandler.isUsed).toBe(true);
    expect(anotherHandler.isUsed).toBe(true);
  });

  test("handles parallel requests with one-time handlers", async () => {
    const oneTimeHandler = http.get(
      "/resource",
      () => {
        return HttpResponse.text("One-time");
      },
      { once: true },
    );
    const anotherHandler = http.get("/resource", () => {
      return HttpResponse.text("Another");
    });

    const server = createNativeMswServer(oneTimeHandler, anotherHandler);
    const { baseUrl } = await listen(server);

    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/resource`),
      fetch(`${baseUrl}/resource`),
    ]);

    const bodies = [await first.text(), await second.text()].sort();
    expect(bodies).toEqual(["Another", "One-time"]);
    expect(oneTimeHandler.isUsed).toBe(true);
    expect(anotherHandler.isUsed).toBe(true);
  });

  test("resolutionContext baseUrl matches when host matches", async () => {
    const baseUrl = "http://this-base-url-works.com";
    const server = createNativeMswServer(
      { resolutionContextBaseUrl: baseUrl, onUnhandledRequest: "bypass" },
      http.get("/resource", () => {
        return HttpResponse.text("Mocked response");
      }),
    );
    const { port } = await listen(server);

    const response = await rawRequest({
      port,
      hostHeader: "this-base-url-works.com",
      path: "/resource",
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe("Mocked response");
  });

  test("resolutionContext baseUrl does not match when host differs", async () => {
    const baseUrl = "http://this-base-url-works.com";
    const server = createNativeMswServer(
      { resolutionContextBaseUrl: baseUrl, onUnhandledRequest: "bypass" },
      http.get("/resource", () => {
        return HttpResponse.text("Mocked response");
      }),
    );
    const { port } = await listen(server);

    const response = await rawRequest({
      port,
      hostHeader: "not-the-base-url.com",
      path: "/resource",
    });
    expect(response.status).toBe(404);
  });

  test("custom predicate matches when returning true", async () => {
    const server = createNativeMswServer(
      http.post(
        async ({ request }) => {
          const body = (await request.clone().json()) as { username: string; password: string };
          return body.username === "test" && body.password === "password";
        },
        () => {
          return HttpResponse.json({ success: true });
        },
      ),
    );
    const { baseUrl } = await listen(server);
    const events = observeLifecycle(server);

    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "test", password: "password" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(eventNames(events)).toEqual([
      "request:start",
      "request:match",
      "request:end",
      "response:mocked",
    ]);
  });

  test("custom predicate does not match when returning false", async () => {
    const onUnhandledRequest = vi.fn();
    const server = createNativeMswServer(
      { onUnhandledRequest },
      http.post(
        async ({ request }) => {
          const body = (await request.clone().json()) as { username: string; password: string };
          return body.username === "test" && body.password === "password";
        },
        () => {
          return HttpResponse.json({ success: true });
        },
      ),
    );
    const { baseUrl } = await listen(server);
    const events = observeLifecycle(server);

    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "test", password: "passwordd" }),
    });

    expect(response.status).toBe(404);
    expect(eventNames(events)).toEqual(["request:start", "request:unhandled", "request:end"]);
    expect(onUnhandledRequest).toHaveBeenCalledTimes(1);
  });
});
