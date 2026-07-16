// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Control the mock capnweb session from tests: `hangAuthProbe` makes the
// liveness/confirm probe (every authenticate() AFTER the first per socket) hang,
// modelling a half-open transport whose root was already established.
const control = vi.hoisted(() => ({
  hangAuthProbe: false,
  authProbeError: undefined as Error | undefined,
}));

// Mock the capnweb session so dialing resolves to a disposable sentinel keyed
// by the socket URL and the authenticate()/projects.get(slug) pipeline — we
// assert on identity/url, never a real RPC session. The FIRST authenticate()
// per socket is the pipelined root (always returns synchronously); later calls
// are the awaited liveness probe, which `hangAuthProbe` can wedge.
vi.mock("capnweb", () => ({
  newWebSocketRpcSession: (ws: { url: string }) => {
    let calls = 0;
    return {
      authenticate: () => {
        calls += 1;
        if (calls > 1 && control.hangAuthProbe) return new Promise(() => {});
        if (calls > 1 && control.authProbeError) return Promise.reject(control.authProbeError);
        const handleFor = (suffix: string) => ({
          url: suffix ? `${ws.url}/${suffix}` : ws.url,
          [Symbol.dispose]: vi.fn(),
        });
        return Object.assign(handleFor(""), {
          projects: { get: (slug: string) => handleFor(slug) },
        });
      },
    };
  },
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
  control.hangAuthProbe = false;
  control.authProbeError = undefined;
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.resetModules(); // fresh module-level session state per test
});
afterEach(() => vi.unstubAllGlobals());

const onlySocket = () => {
  expect(FakeWebSocket.instances).toHaveLength(1);
  return FakeWebSocket.instances[0]!;
};

/** Open the newest socket and let its awaited auth-confirm probe settle. */
async function openLatest() {
  FakeWebSocket.instances.at(-1)!.fire("open");
  await vi.waitFor(() => {});
}

describe("itx session socket", () => {
  test("ONE socket for the whole tab: connectSession returns the same promise and resolves to the Session", async () => {
    const { connectSession } = await import("./itx-react.tsx");
    const a = connectSession();
    expect(connectSession()).toBe(a); // one dial, the stable promise use() needs
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onlySocket().url).toContain("/api");
    await openLatest();
    await expect(a).resolves.toMatchObject({ url: expect.stringContaining("/api") });
  });

  test("connectItx narrows the ONE session to a project stub — no second socket", async () => {
    const { connectSession, connectItx } = await import("./itx-react.tsx");
    const session = connectSession(); // dials the one socket
    await openLatest();
    const acme = await connectItx("acme");
    const other = await connectItx("prj_123");
    // Both project handles ride the ONE socket the session dialed.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(acme).toMatchObject({ url: expect.stringContaining("/api/acme") });
    expect(other).toMatchObject({ url: expect.stringContaining("/api/prj_123") });
    await expect(session).resolves.toMatchObject({ url: expect.stringContaining("/api") });
  });

  test("a dial that closes before opening rejects awaiters instead of hanging, then re-dials", async () => {
    const { connectSession } = await import("./itx-react.tsx");
    const first = connectSession();
    onlySocket().fire("close"); // closed before it ever opened
    await expect(first).rejects.toThrow(/closed before connecting/);
    // The entry was dropped, so the next connect dials a fresh socket.
    const second = connectSession();
    expect(second).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("INVISIBLE RECONNECT: a live session survives a transport gap and auto-redials", async () => {
    const { connectSession } = await import("./itx-react.tsx");
    const first = connectSession();
    await openLatest();
    const session = await first;

    // Transport dies AFTER being live: the socket is auto-redialed and the last
    // session stays available (no re-suspend) — connectSession hands out the new
    // generation's promise, not the corpse.
    FakeWebSocket.instances[0]!.fire("close");
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = connectSession();
    expect(second).not.toBe(first);
    // The old session is RETAINED through the gap (so useSession/useItx never
    // hand out a disposed stub) — it is disposed only when its successor opens.
    expect(session[Symbol.dispose]).not.toHaveBeenCalled();
    await openLatest();
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  test("reconnectItx (semantic reset) retires the old session only once its successor publishes", async () => {
    const { connectSession, reconnectItx } = await import("./itx-react.tsx");
    const first = connectSession();
    await openLatest();
    const session = await first;

    reconnectItx();
    await vi.waitFor(() => {});
    // Retained until the successor publishes — no disposed stub during the gap.
    expect(session[Symbol.dispose]).not.toHaveBeenCalled();
    expect(connectSession()).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await openLatest();
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  test("a superseded generation's late open never publishes over the live one", async () => {
    const { connectSession, reconnectItx } = await import("./itx-react.tsx");
    const first = connectSession();
    reconnectItx(); // supersede the first dial before it ever opened
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = connectSession();
    // The stale first socket opens LATE: it must close itself, not publish.
    FakeWebSocket.instances[0]!.fire("open");
    await vi.waitFor(() => {});
    expect(connectSession()).toBe(second); // still the successor, not the corpse
    // The successor opening is what actually publishes a session.
    FakeWebSocket.instances[1]!.fire("open");
    await expect(second).resolves.toMatchObject({ url: expect.stringContaining("/api") });
  });

  test("verifier: an application-error probe means the socket ANSWERED — no reconnect", async () => {
    // The probe (authenticate) rejects with a non-transport error: the transport
    // is alive, so two 10s windows must NOT retire the socket.
    vi.useFakeTimers();
    try {
      const { connectSession, reportTransportSuspicion } = await import("./itx-react.tsx");
      const first = connectSession();
      FakeWebSocket.instances[0]!.fire("open");
      await vi.advanceTimersByTimeAsync(0);
      await first;

      control.authProbeError = new Error("permission denied"); // NOT a transport error
      reportTransportSuspicion();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(connectSession()).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  test("repeated closed-before-open dials get backoff from the SECOND consecutive failure", async () => {
    vi.useFakeTimers();
    try {
      const { connectSession } = await import("./itx-react.tsx");
      connectSession();
      FakeWebSocket.instances[0]!.fire("close"); // failure 1
      connectSession(); // first retry is immediate
      expect(FakeWebSocket.instances).toHaveLength(2);
      FakeWebSocket.instances[1]!.fire("close"); // failure 2
      connectSession(); // now paced: no socket yet
      expect(FakeWebSocket.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(250);
      expect(FakeWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reportTransportSuspicion leaves a HEALTHY socket alone (no false-positive reconnect)", async () => {
    const { connectSession, reportTransportSuspicion } = await import("./itx-react.tsx");
    const first = connectSession();
    await openLatest();
    await first;
    // The auth probe answers immediately (alive), so two-strike verification
    // keeps the socket: a busy-but-alive transport must not be torn down.
    reportTransportSuspicion();
    await vi.waitFor(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(connectSession()).toBe(first);
  });

  test("reportTransportSuspicion re-dials a genuinely half-open socket after two strikes", async () => {
    vi.useFakeTimers();
    try {
      const { connectSession, reportTransportSuspicion } = await import("./itx-react.tsx");
      const first = connectSession();
      FakeWebSocket.instances[0]!.fire("open");
      await vi.advanceTimersByTimeAsync(0);
      await first;

      // The transport goes half-open: probes now hang. Two 10s strikes retire it.
      control.hangAuthProbe = true;
      reportTransportSuspicion();
      await vi.advanceTimersByTimeAsync(10_000); // strike one
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000); // strike two → reconnect
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(connectSession()).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The liveness watchdog is module-private; these tests drive it through the
// public useItxSubscription hook with a real React tree — which also covers the
// epoch/re-subscribe integration the bare watchdog can't show.
describe("useItxSubscription liveness", () => {
  const INTERVAL = 45_000;
  const PING_TIMEOUT = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => vi.useRealTimers());

  /**
   * Mount a component holding one useItxSubscription, under a <ProjectScope> so
   * the ambient project resolves. Everything is imported AFTER the file-level
   * vi.resetModules() so the harness's React instance is the one itx-react
   * loaded (a static import would be a different copy — invalid-hook-call).
   */
  async function mountSubscription(
    makeHandle: () => {
      ping: () => boolean | Promise<boolean>;
      unsubscribe: () => void;
    },
  ) {
    const [{ useItxSubscription, ProjectScope }, React, { createRoot }] = await Promise.all([
      import("./itx-react.tsx"),
      import("react"),
      import("react-dom/client"),
    ]);
    const { act, createElement } = React;

    const subscribe = vi.fn(async () => makeHandle());
    function Harness() {
      const subscription = useItxSubscription(subscribe as never, []);
      return createElement("output", { "data-status": subscription.status });
    }

    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ProjectScope, { slug: "acme", children: createElement(Harness) }));
    });
    // The subscription awaits the connection inside its effect (never suspends);
    // open the socket and let the effect + async subscribe settle.
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

  test("a hanging ping (silent death) re-subscribes and reports transport suspicion", async () => {
    let handles = 0;
    const harness = await mountSubscription(() => {
      handles += 1;
      const mine = handles;
      // The FIRST handle's ping hangs; its replacement answers, so recovery is a
      // re-subscribe on the (healthy, per the mock) transport.
      return {
        ping: () => (mine > 1 ? true : new Promise<boolean>(() => {})),
        unsubscribe: vi.fn(),
      };
    });

    // TWO ping timeouts (two-strike): after the FIRST nothing recovers yet.
    await harness.advance(INTERVAL + PING_TIMEOUT);
    expect(harness.subscribe).toHaveBeenCalledTimes(1);
    await harness.advance(PING_TIMEOUT);
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

    document.dispatchEvent(new Event("visibilitychange"));
    await harness.advance(0);
    expect(harness.subscribe).toHaveBeenCalledTimes(2);
    await harness.unmount();
  });
});
