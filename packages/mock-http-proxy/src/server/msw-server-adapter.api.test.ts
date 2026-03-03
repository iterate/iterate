import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { HttpResponse, http } from "msw";
import { createNativeMswServer, type NativeMswServer } from "./msw-server-adapter.ts";

const activeServers = new Set<NativeMswServer>();

async function listen(server: NativeMswServer): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  activeServers.add(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
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

afterEach(async () => {
  for (const server of activeServers) {
    await close(server);
  }
});

describe("createNativeMswServer", () => {
  test("supports runtime handlers + reset/restore/list", async () => {
    const server = createNativeMswServer(
      http.get("/v1/hello", () => HttpResponse.json({ source: "initial" })),
    );
    const baseUrl = await listen(server);

    const fetchJson = async () => {
      const response = await fetch(`${baseUrl}/v1/hello`);
      return (await response.json()) as { source: string };
    };

    await expect(fetchJson()).resolves.toEqual({ source: "initial" });
    expect(server.listHandlers().length).toBe(1);

    server.use(http.get("/v1/hello", () => HttpResponse.json({ source: "runtime" })));
    expect(server.listHandlers().length).toBe(2);
    await expect(fetchJson()).resolves.toEqual({ source: "runtime" });

    server.resetHandlers();
    expect(server.listHandlers().length).toBe(1);
    await expect(fetchJson()).resolves.toEqual({ source: "initial" });

    server.use(http.get("/v1/hello", () => HttpResponse.json({ source: "once" }), { once: true }));
    await expect(fetchJson()).resolves.toEqual({ source: "once" });
    await expect(fetchJson()).resolves.toEqual({ source: "initial" });

    server.restoreHandlers();
    await expect(fetchJson()).resolves.toEqual({ source: "once" });
  });

  test("emits lifecycle events via server.events", async () => {
    const server = createNativeMswServer(
      http.get("/v1/events", () => HttpResponse.json({ ok: true })),
    );
    const baseUrl = await listen(server);

    const seen = {
      eventsApiMatch: 0,
      mocked: 0,
    };

    server.events.on("request:match", () => {
      seen.eventsApiMatch += 1;
    });
    server.events.on("response:mocked", () => {
      seen.mocked += 1;
    });
    const response = await fetch(`${baseUrl}/v1/events`);
    expect(response.status).toBe(200);

    expect(seen.eventsApiMatch).toBe(1);
    expect(seen.mocked).toBe(1);
  });

  test("returns 502 when unhandled bypass target resolves to self", async () => {
    const server = createNativeMswServer();
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/no-match`);
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toContain("Refusing to bypass request");
  });
});
