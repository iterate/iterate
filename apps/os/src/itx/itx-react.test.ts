// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the capnweb session so dialing resolves to a disposable sentinel keyed
// by the socket URL and (post-cutover) the authenticate()/projects.get(id)
// pipeline — we assert on identity/url, never a real RPC session.
vi.mock("capnweb", () => ({
  newWebSocketRpcSession: (ws: { url: string }) => ({
    authenticate: () => {
      const handleFor = (suffix: string) => ({
        url: suffix ? `${ws.url}/${suffix}` : ws.url,
        [Symbol.dispose]: vi.fn(),
      });
      return Object.assign(handleFor(""), {
        projects: { get: (projectId: string) => handleFor(projectId) },
      });
    },
  }),
}));

/** A WebSocket we can drive: record instances, fire open/close by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  private handlers: Record<string, Array<() => void>> = {};
  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: () => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  close() {
    this.fire("close");
  }
  fire(type: string) {
    for (const cb of this.handlers[type] ?? []) cb();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.resetModules(); // fresh module-level socket Map per test
});
afterEach(() => vi.unstubAllGlobals());

const onlySocket = () => {
  expect(FakeWebSocket.instances).toHaveLength(1);
  return FakeWebSocket.instances[0]!;
};

describe("itx socket map", () => {
  test("connectItxBrowser returns the SAME promise per context — one dial, the stable promise use() needs", async () => {
    const { connectItxBrowser } = await import("./itx-react.tsx");
    const a = connectItxBrowser({ projectId: "acme" });
    expect(connectItxBrowser({ projectId: "acme" })).toBe(a);
    expect(FakeWebSocket.instances).toHaveLength(1);
    onlySocket().fire("open");
    await expect(a).resolves.toMatchObject({ url: expect.stringContaining("/api/itx/acme") });
  });

  test("contexts are independent; the global context (no projectId) is its own socket", async () => {
    const { connectItxBrowser } = await import("./itx-react.tsx");
    const global = connectItxBrowser();
    expect(connectItxBrowser({ projectId: "acme" })).not.toBe(global);
    expect(connectItxBrowser()).toBe(global);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // One endpoint for every context now — the project narrows client-side.
    expect(FakeWebSocket.instances[0]!.url).toContain("/api/itx");
    expect(FakeWebSocket.instances[1]!.url).toContain("/api/itx");
  });

  test("a closed socket is dropped; the next connectItxBrowser dials a fresh one", async () => {
    const { connectItxBrowser } = await import("./itx-react.tsx");
    const first = connectItxBrowser({ projectId: "acme" });
    onlySocket().fire("open");
    await first;

    FakeWebSocket.instances[0]!.fire("close"); // socket dies
    const second = connectItxBrowser({ projectId: "acme" });
    expect(second).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("a dial that closes before opening rejects awaiters instead of hanging", async () => {
    // Regression: a failed/timed-out dial used to leave the cached connecting
    // promise forever-pending, so `await connectItxBrowser()` (event handlers,
    // mutationFns) hung. It must reject so imperative callers fail fast.
    const { connectItxBrowser } = await import("./itx-react.tsx");
    const first = connectItxBrowser({ projectId: "acme" });
    onlySocket().fire("close"); // closed before it ever opened
    await expect(first).rejects.toThrow(/closed before connecting/);

    // The entry was still dropped, so the next connect dials a fresh socket.
    const second = connectItxBrowser({ projectId: "acme" });
    expect(second).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("a stale socket's death never drops its successor", async () => {
    const { connectItxBrowser } = await import("./itx-react.tsx");
    connectItxBrowser({ projectId: "acme" });
    FakeWebSocket.instances[0]!.fire("close"); // first dies → dropped
    const second = connectItxBrowser({ projectId: "acme" }); // re-dials
    FakeWebSocket.instances[0]!.fire("close"); // stale repeat — must NOT drop the second
    expect(connectItxBrowser({ projectId: "acme" })).toBe(second);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("reconnectItx disposes the live socket and forces a fresh dial", async () => {
    const { connectItxBrowser, reconnectItx } = await import("./itx-react.tsx");
    const first = connectItxBrowser({ projectId: "acme" });
    onlySocket().fire("open");
    const session = await first;

    reconnectItx({ projectId: "acme" });
    await Promise.resolve(); // let the dispose .then() run
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);

    expect(connectItxBrowser({ projectId: "acme" })).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("watchItxSubscription", () => {
  // The watchdog's cadence (see the constants in itx-react.tsx).
  const INTERVAL = 45_000;
  const PING_TIMEOUT = 10_000;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a subscription that keeps answering true is left alone", async () => {
    const { watchItxSubscription } = await import("./itx-react.tsx");
    let pings = 0;
    const onDead = vi.fn();
    const stop = watchItxSubscription(() => {
      pings += 1;
      return true;
    }, onDead);

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(pings).toBe(3);
    expect(onDead).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(pings).toBe(3); // stopped: no further checks
  });

  test("ping answering false reports dead exactly once and stops", async () => {
    const { watchItxSubscription } = await import("./itx-react.tsx");
    const onDead = vi.fn();
    watchItxSubscription(() => false, onDead);

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith("dead");
  });

  test("a rejecting ping (dead DO incarnation) reports dead", async () => {
    const { watchItxSubscription } = await import("./itx-react.tsx");
    const onDead = vi.fn();
    watchItxSubscription(() => Promise.reject(new Error("Durable Object reset")), onDead);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith("dead");
  });

  test("a hanging ping (half-open socket) reports timed-out AND drops every socket", async () => {
    const { connectItxBrowser, watchItxSubscription } = await import("./itx-react.tsx");
    // A live socket that the recovery must drop.
    const first = connectItxBrowser({ projectId: "acme" });
    onlySocket().fire("open");
    await first;

    const onDead = vi.fn();
    watchItxSubscription(() => new Promise<boolean>(() => {}), onDead);

    await vi.advanceTimersByTimeAsync(INTERVAL + PING_TIMEOUT);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith("timed-out");
    // reconnectAllItx ran: the cached socket promise was dropped, so the next
    // read dials fresh.
    expect(connectItxBrowser({ projectId: "acme" })).not.toBe(first);
  });

  test("the tab becoming visible triggers an immediate check", async () => {
    const { watchItxSubscription } = await import("./itx-react.tsx");
    const onDead = vi.fn();
    watchItxSubscription(() => false, onDead);

    // No interval has elapsed — visibility alone must trigger the check
    // (waking from sleep is exactly when the socket is most likely dead).
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onDead).toHaveBeenCalledWith("dead");
  });
});
