// Unit tests for the per-tab browser itx connection: lazy connect, shared
// waiters, capped backoff with jitter, project-handle caching across socket
// drops, the stale-rejection cache guard, and dispose().
//
// capnweb is mocked at the module boundary; WebSocket and window are stubbed
// globals so tests fire "open"/"close" by hand. Math.random is pinned to 0 so
// backoff delays are exact (jitter adds up to 25% on top otherwise).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createItxBrowserClient } from "./connection.ts";

const capnwebMocks = vi.hoisted(() => ({
  newWebSocketRpcSession: vi.fn(),
}));

vi.mock("capnweb", () => capnwebMocks);

class FakeWebSocket {
  url: string;
  close = vi.fn();
  private listeners = new Map<string, Set<() => void>>();

  constructor(url: URL | string) {
    this.url = String(url);
    sockets.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  fire(type: "open" | "close") {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

let sockets: FakeWebSocket[] = [];

function makeStub() {
  return {
    projects: { get: vi.fn((slug: string) => Promise.resolve({ slug })) },
    [Symbol.dispose]: vi.fn(),
  };
}
type FakeStub = ReturnType<typeof makeStub>;

let stubs: FakeStub[] = [];

async function flush() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

describe("createItxBrowserClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("window", { location: { href: "https://os.test/" } });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    sockets = [];
    stubs = [];
    capnwebMocks.newWebSocketRpcSession.mockReset().mockImplementation(() => {
      const stub = makeStub();
      stubs.push(stub);
      return stub;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("connects lazily: no socket until the first itx() call", () => {
    const client = createItxBrowserClient();
    expect(sockets).toHaveLength(0);
    expect(client.getStatus()).toBe("idle");

    void client.itx();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe("wss://os.test/api/itx");

    // A second caller joins the in-flight connect; no second socket.
    void client.itx();
    expect(sockets).toHaveLength(1);
  });

  test("waiters before open all resolve with the same stub; status walks idle→connecting→connected", async () => {
    const client = createItxBrowserClient();
    const statuses: string[] = [];
    client.subscribeStatus(() => statuses.push(client.getStatus()));
    expect(client.getStatus()).toBe("idle");

    const p1 = client.itx();
    const p2 = client.itx();
    expect(client.getStatus()).toBe("connecting");
    expect(statuses).toEqual(["connecting"]);

    sockets[0]!.fire("open");
    expect(client.getStatus()).toBe("connected");
    expect(statuses).toEqual(["connecting", "connected"]);

    const [stub1, stub2] = await Promise.all([p1, p2]);
    expect(stub1).toBe(stub2);
    expect(stub1).toBe(stubs[0]);
    expect(capnwebMocks.newWebSocketRpcSession).toHaveBeenCalledTimes(1);
  });

  test("reconnects with doubling backoff capped at 10s; a successful open resets it", async () => {
    const client = createItxBrowserClient();
    void client.itx();

    sockets[0]!.fire("close");
    expect(client.getStatus()).toBe("reconnecting");

    // Math.random is 0, so each delay is exactly the current backoff.
    for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
      const count = sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(count + 1);
      sockets[sockets.length - 1]!.fire("close");
    }

    // A successful connect resets the backoff to 500ms.
    await vi.advanceTimersByTimeAsync(10_000);
    const connected = sockets[sockets.length - 1]!;
    connected.fire("open");
    expect(client.getStatus()).toBe("connected");

    connected.fire("close");
    const count = sockets.length;
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(count + 1);
  });

  test("project handles are cached per slug and the cache clears on close", async () => {
    const client = createItxBrowserClient();
    const pending = client.itx();
    sockets[0]!.fire("open");
    await pending;

    const p1 = client.project("x");
    const p2 = client.project("x");
    expect(p2).toBe(p1);
    await p1;
    expect(stubs[0]!.projects.get).toHaveBeenCalledTimes(1);
    expect(stubs[0]!.projects.get).toHaveBeenCalledWith("x");

    // Socket drop kills the live handles; reconnect rebuilds them on demand.
    sockets[0]!.fire("close");
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.fire("open");

    await client.project("x");
    expect(stubs[0]!.projects.get).toHaveBeenCalledTimes(1);
    expect(stubs[1]!.projects.get).toHaveBeenCalledTimes(1);
  });

  test("a stale handle rejection does not evict a fresh post-reconnect cache entry", async () => {
    const client = createItxBrowserClient();
    const pending = client.itx();
    sockets[0]!.fire("open");
    await pending;

    // First handle hangs on a deferred projects.get…
    const deferred = Promise.withResolvers<unknown>();
    stubs[0]!.projects.get.mockReturnValue(deferred.promise as Promise<{ slug: string }>);
    const stale = client.project("x");
    stale.catch(() => {});
    await flush();
    expect(stubs[0]!.projects.get).toHaveBeenCalledTimes(1);

    // …the socket drops (cache cleared) and the reconnect repopulates it.
    sockets[0]!.fire("close");
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.fire("open");
    const fresh = client.project("x");
    await fresh;
    expect(stubs[1]!.projects.get).toHaveBeenCalledTimes(1);

    // Now the stale handle finally rejects. The guard compares promise
    // identity, so the fresh entry must survive.
    deferred.reject(new Error("stale socket handle"));
    await flush();

    expect(client.project("x")).toBe(fresh);
    expect(stubs[0]!.projects.get).toHaveBeenCalledTimes(1);
    expect(stubs[1]!.projects.get).toHaveBeenCalledTimes(1);
  });

  test("dispose() rejects pending waiters, stops reconnecting, and rejects later calls", async () => {
    const client = createItxBrowserClient();
    const waiter = client.itx();

    // Connect fails; a reconnect is pending when dispose() lands.
    sockets[0]!.fire("close");
    expect(client.getStatus()).toBe("reconnecting");

    client.dispose();
    await expect(waiter).rejects.toThrow("The itx connection was closed.");
    expect(client.getStatus()).toBe("idle");

    // The scheduled reconnect was cancelled: no new socket, ever.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);

    await expect(client.itx()).rejects.toThrow("The itx client has been disposed.");
    expect(client.getStatus()).toBe("idle");
  });

  test("dispose() while connected closes the socket and disposes the stub", async () => {
    const client = createItxBrowserClient();
    const pending = client.itx();
    sockets[0]!.fire("open");
    const stub = await pending;

    client.dispose();
    expect(stubs[0]![Symbol.dispose]).toHaveBeenCalledTimes(1);
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toBe("idle");
    expect(stub).toBe(stubs[0]);
  });
});
