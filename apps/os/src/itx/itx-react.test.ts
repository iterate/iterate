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
    await expect(a).resolves.toMatchObject({ url: expect.stringContaining("/api/acme") });
  });

  test("contexts are independent; the global context (no projectId) is its own socket", async () => {
    const { connectItxBrowser } = await import("./itx-react.tsx");
    const global = connectItxBrowser();
    expect(connectItxBrowser({ projectId: "acme" })).not.toBe(global);
    expect(connectItxBrowser()).toBe(global);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // One endpoint for every context now — the project narrows client-side.
    expect(FakeWebSocket.instances[0]!.url).toContain("/api");
    expect(FakeWebSocket.instances[1]!.url).toContain("/api");
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

// The liveness watchdog is module-private; these tests drive it through the
// public useItxSubscription hook with a real React tree — which also covers
// the epoch/re-subscribe integration the bare watchdog can't show.
describe("useItxSubscription liveness", () => {
  // The watchdog's cadence (see the constants in itx-react.tsx).
  const INTERVAL = 45_000;
  const PING_TIMEOUT = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => vi.useRealTimers());

  /**
   * Mount a component holding one useItxSubscription. Everything is imported
   * AFTER the file-level vi.resetModules() so the harness's React instance is
   * the same one itx-react loaded (a static react import here would be a
   * different copy — instant invalid-hook-call).
   */
  async function mountSubscription(
    makeHandle: () => {
      ping: () => boolean | Promise<boolean>;
      unsubscribe: () => void;
    },
  ) {
    const [{ useItxSubscription }, React, { createRoot }] = await Promise.all([
      import("./itx-react.tsx"),
      import("react"),
      import("react-dom/client"),
    ]);
    const { act, createElement, Suspense } = React;

    const subscribe = vi.fn(async () => makeHandle());
    function Harness() {
      const subscription = useItxSubscription(subscribe as never, []);
      return createElement("output", { "data-status": subscription.status });
    }

    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Suspense, { fallback: null }, createElement(Harness)));
    });
    // The hook suspended on the socket dial; open it and let the effect +
    // async subscribe settle.
    await act(async () => {
      FakeWebSocket.instances.at(-1)!.fire("open");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    return {
      subscribe,
      status: () => container.querySelector("output")?.getAttribute("data-status"),
      advance: (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms)),
      unmount: () => act(async () => root.unmount()),
    };
  }

  test("a subscription that keeps answering true stays live and is left alone", async () => {
    let pings = 0;
    const harness = await mountSubscription(() => ({
      ping: () => {
        pings += 1;
        return true;
      },
      unsubscribe: vi.fn(),
    }));

    expect(harness.status()).toBe("live");
    await harness.advance(INTERVAL * 3);
    expect(pings).toBe(3);
    expect(harness.subscribe).toHaveBeenCalledTimes(1); // never re-subscribed
    expect(harness.status()).toBe("live");
    await harness.unmount();
  });

  test("ping answering false (server-side subscription gone) re-subscribes", async () => {
    let handles = 0;
    const harness = await mountSubscription(() => {
      handles += 1;
      const mine = handles;
      // The FIRST handle dies on the first ping; its replacement stays live.
      return { ping: () => mine > 1, unsubscribe: vi.fn() };
    });

    expect(harness.status()).toBe("live");
    await harness.advance(INTERVAL);
    expect(harness.subscribe).toHaveBeenCalledTimes(2); // recovered via a fresh subscribe
    expect(harness.status()).toBe("live");
    await harness.advance(INTERVAL * 2);
    expect(harness.subscribe).toHaveBeenCalledTimes(2); // and then left alone
    await harness.unmount();
  });

  test("a rejecting ping (dead DO incarnation) re-subscribes", async () => {
    let handles = 0;
    const harness = await mountSubscription(() => {
      handles += 1;
      const mine = handles;
      return {
        ping: () => (mine > 1 ? true : Promise.reject(new Error("Durable Object reset"))),
        unsubscribe: vi.fn(),
      };
    });

    await harness.advance(INTERVAL);
    expect(harness.subscribe).toHaveBeenCalledTimes(2);
    expect(harness.status()).toBe("live");
    await harness.unmount();
  });

  test("a hanging ping (half-open socket) drops every socket so consumers re-dial", async () => {
    const { connectItxBrowser } = await import("./itx-react.tsx");
    const harness = await mountSubscription(() => ({
      ping: () => new Promise<boolean>(() => {}),
      unsubscribe: vi.fn(),
    }));
    const socketsBefore = FakeWebSocket.instances.length;
    const globalSocket = connectItxBrowser();

    await harness.advance(INTERVAL + PING_TIMEOUT);
    // reconnectAllItx ran: the cached socket promise was dropped, the hook
    // re-suspended, and a FRESH dial started.
    expect(connectItxBrowser()).not.toBe(globalSocket);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore);

    // The fresh socket opens → the effect re-runs → a fresh subscription.
    await act(harness, async () => {
      FakeWebSocket.instances.at(-1)!.fire("open");
    });
    await harness.advance(0);
    expect(harness.subscribe).toHaveBeenCalledTimes(2);
    expect(harness.status()).toBe("live");
    await harness.unmount();
  });

  test("the tab becoming visible triggers an immediate liveness check", async () => {
    let handles = 0;
    const harness = await mountSubscription(() => {
      handles += 1;
      const mine = handles;
      return { ping: () => mine > 1, unsubscribe: vi.fn() };
    });

    // No interval has elapsed — visibility alone must trigger the check
    // (waking from sleep is exactly when the socket is most likely dead).
    document.dispatchEvent(new Event("visibilitychange"));
    await harness.advance(0);
    expect(harness.subscribe).toHaveBeenCalledTimes(2);
    await harness.unmount();
  });
});

/** act() through the harness's own React copy (post-resetModules instance). */
async function act(
  _harness: { advance: (ms: number) => Promise<unknown> },
  work: () => Promise<void> | void,
): Promise<void> {
  const React = await import("react");
  await React.act(async () => {
    await work();
  });
}
