// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Control the mock capnweb session from tests: `hangAuthProbe` makes the
// liveness/confirm probe (every authenticate() AFTER the first per socket) hang,
// modelling a half-open transport whose root was already established.
// `authError` makes the FIRST authenticate reject (a terminal handshake
// failure); `lastRoot` is the resolved session the latest dial produced.
const control = vi.hoisted(() => ({
  hangAuthProbe: false,
  hangFirstAuth: false,
  authProbeError: undefined as Error | undefined,
  authError: undefined as Error | undefined,
  lastRoot: undefined as unknown,
}));

// Mock the capnweb session so dialing resolves to a disposable sentinel keyed
// by the socket URL and the authenticate()/projects.get(slug) pipeline — we
// assert on identity/url, never a real RPC session. The FIRST authenticate()
// per socket models the RpcPromise: a THENABLE whose resolution is the real
// session handle — the code must await it and publish the RESOLVED identity
// (resolving a native promise with the thenable itself would assimilate).
// Later calls are the awaited liveness probe, which `hangAuthProbe` can wedge.
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
        if (calls > 1) return handleFor("");
        if (control.hangFirstAuth) return new Promise(() => {});
        if (control.authError) return Promise.reject(control.authError);
        const root = Object.assign(handleFor(""), {
          projects: { get: (slug: string) => handleFor(slug) },
        });
        control.lastRoot = root;
        // The RpcPromise stand-in: thenable, resolves to the root handle.
        return { then: (onResolve: (value: unknown) => void) => onResolve(root) };
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
  control.hangFirstAuth = false;
  control.authProbeError = undefined;
  control.authError = undefined;
  control.lastRoot = undefined;
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
  test("ONE socket for the whole tab: connectIterateSession returns the same promise and resolves to the Session", async () => {
    const { connectIterateSession } = await import("./itx-react.tsx");
    const a = connectIterateSession();
    expect(connectIterateSession()).toBe(a); // one dial, the stable promise use() needs
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onlySocket().url).toContain("/api");
    await openLatest();
    await expect(a).resolves.toMatchObject({ url: expect.stringContaining("/api") });
  });

  test("connectItx narrows the ONE session to a project stub — no second socket", async () => {
    const { connectIterateSession, connectItx } = await import("./itx-react.tsx");
    const session = connectIterateSession(); // dials the one socket
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
    const { connectIterateSession } = await import("./itx-react.tsx");
    const first = connectIterateSession();
    onlySocket().fire("close"); // closed before it ever opened
    await expect(first).rejects.toThrow(/closed before connecting/);
    // The entry was dropped, so the next connect dials a fresh socket.
    const second = connectIterateSession();
    expect(second).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("INVISIBLE RECONNECT: a live session survives a transport gap and auto-redials", async () => {
    const { connectIterateSession } = await import("./itx-react.tsx");
    const first = connectIterateSession();
    await openLatest();
    const session = await first;

    // Transport dies AFTER being live: the socket is auto-redialed and the last
    // session stays available (no re-suspend) — connectIterateSession hands out the new
    // generation's promise, not the corpse.
    FakeWebSocket.instances[0]!.fire("close");
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = connectIterateSession();
    expect(second).not.toBe(first);
    // The old session is RETAINED through the gap (so useIterateSession/useItx never
    // hand out a disposed stub) — it is disposed only when its successor opens.
    expect(session[Symbol.dispose]).not.toHaveBeenCalled();
    await openLatest();
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  test("reconnectIterateSession (semantic reset) retires the old session only once its successor publishes", async () => {
    const { connectIterateSession, reconnectIterateSession } = await import("./itx-react.tsx");
    const first = connectIterateSession();
    await openLatest();
    const session = await first;

    reconnectIterateSession();
    await vi.waitFor(() => {});
    // Retained until the successor publishes — no disposed stub during the gap.
    expect(session[Symbol.dispose]).not.toHaveBeenCalled();
    expect(connectIterateSession()).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await openLatest();
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  test("a superseded generation's late open never publishes over the live one", async () => {
    const { connectIterateSession, reconnectIterateSession } = await import("./itx-react.tsx");
    connectIterateSession();
    reconnectIterateSession(); // supersede the first dial before it ever opened
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = connectIterateSession();
    // The stale first socket opens LATE: it must close itself, not publish.
    FakeWebSocket.instances[0]!.fire("open");
    await vi.waitFor(() => {});
    // The CAS bails BEFORE creating an RPC session: the corpse never even
    // authenticates (a published corpse would poison snapshot.session).
    expect(control.lastRoot).toBeUndefined();
    expect(connectIterateSession()).toBe(second); // still the successor, not the corpse
    // The successor opening is what actually publishes a session.
    FakeWebSocket.instances[1]!.fire("open");
    await expect(second).resolves.toMatchObject({ url: expect.stringContaining("/api") });
  });

  test("verifier: an application-error probe means the socket ANSWERED — no reconnect", async () => {
    // The probe (authenticate) rejects with a non-transport error: the transport
    // is alive, so two 10s windows must NOT retire the socket.
    vi.useFakeTimers();
    try {
      const { connectIterateSession, reportTransportSuspicion } = await import("./itx-react.tsx");
      const first = connectIterateSession();
      FakeWebSocket.instances[0]!.fire("open");
      await vi.advanceTimersByTimeAsync(0);
      await first;

      control.authProbeError = new Error("permission denied"); // NOT a transport error
      reportTransportSuspicion();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(connectIterateSession()).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  test("repeated closed-before-open dials get backoff from the SECOND consecutive failure", async () => {
    vi.useFakeTimers();
    try {
      const { connectIterateSession } = await import("./itx-react.tsx");
      connectIterateSession();
      FakeWebSocket.instances[0]!.fire("close"); // failure 1
      connectIterateSession(); // first retry is immediate
      expect(FakeWebSocket.instances).toHaveLength(2);
      FakeWebSocket.instances[1]!.fire("close"); // failure 2
      connectIterateSession(); // now paced: no socket yet
      expect(FakeWebSocket.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(250);
      expect(FakeWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("isItxTransportError classifies exactly the three transport signatures", async () => {
    const { isItxTransportError } = await import("./itx-react.tsx");
    expect(isItxTransportError(new Error("itx WebSocket closed before connecting"))).toBe(true);
    expect(isItxTransportError(new Error("Peer closed WebSocket: 1006 "))).toBe(true);
    expect(isItxTransportError(new Error("WebSocket connection failed."))).toBe(true);
    // An application error that merely MENTIONS WebSocket is not a transport close.
    expect(isItxTransportError(new Error("WebSocket subscriptions require admin"))).toBe(false);
    expect(isItxTransportError(new Error("permission denied"))).toBe(false);
  });

  test("FIRST-LOAD SUSPENSE survives a closed-before-open dial — never the error boundary", async () => {
    // A suspended (never-committed) component replays against the thenable it
    // first used, so a rejected per-dial promise would surface in the error
    // boundary even though a paced re-dial is underway. use() must therefore
    // suspend on the STABLE first-connect promise. Also locks session identity:
    // the hook and the imperative path must hand out the SAME resolved stub.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const [{ useIterateSession, connectIterateSession }, React, { createRoot }] = await Promise.all(
      [import("./itx-react.tsx"), import("react"), import("react-dom/client")],
    );
    const { act, createElement, Component, Suspense } = React;

    let hookSession: unknown;
    function Probe() {
      hookSession = useIterateSession();
      return createElement("output", { "data-state": "ready" });
    }
    class Boundary extends Component<{ children?: unknown }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed
          ? createElement("output", { "data-state": "error" })
          : (this.props.children as ReturnType<typeof createElement>);
      }
    }

    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const state = () => container.querySelector("output")?.getAttribute("data-state");
    await act(async () => {
      root.render(
        createElement(
          Boundary,
          null,
          createElement(
            Suspense,
            { fallback: createElement("output", { "data-state": "loading" }) },
            createElement(Probe),
          ),
        ),
      );
    });
    expect(state()).toBe("loading"); // suspended on the first dial

    // The dial dies before opening: the per-dial promise rejects (imperative
    // awaiters fail fast) but the suspended tree must stay suspended.
    await act(async () => {
      FakeWebSocket.instances[0]!.fire("close");
    });
    expect(state()).toBe("loading");
    expect(FakeWebSocket.instances).toHaveLength(2); // re-dialed immediately

    // The retry opens: the tree resolves, and both paths share one identity.
    await act(async () => {
      FakeWebSocket.instances[1]!.fire("open");
    });
    expect(state()).toBe("ready");
    expect(hookSession).toBe(control.lastRoot);
    expect(await connectIterateSession()).toBe(control.lastRoot);
    await act(async () => root.unmount());
    container.remove();
  });

  test("the dial timeout spans authenticate: a hung handshake closes and re-dials", async () => {
    // A server that accepts the WebSocket but never answers authenticate must
    // be a FAILED dial (close → paced re-dial), not an infinite spinner.
    vi.useFakeTimers();
    try {
      const { connectIterateSession } = await import("./itx-react.tsx");
      control.hangFirstAuth = true;
      const first = connectIterateSession();
      FakeWebSocket.instances[0]!.fire("open"); // opens, then authenticate hangs
      await vi.advanceTimersByTimeAsync(15_000); // DIAL_TIMEOUT_MS
      await expect(first).rejects.toThrow(/closed before connecting/);
      // The timeout closed the wedged socket and a fresh dial replaced it.
      expect(FakeWebSocket.instances).toHaveLength(2);
      control.hangFirstAuth = false;
      const second = connectIterateSession();
      FakeWebSocket.instances[1]!.fire("open");
      await vi.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toBe(control.lastRoot);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a terminal authenticate rejection PARKS: no dial storm, explicit reset revives", async () => {
    // A real auth answer over a working socket is terminal. The failed
    // generation must keep owning the slot: renders re-read the snapshot (which
    // dials when the slot is empty) and the failure's own setState re-renders —
    // clearing the slot here would be an unbounded WebSocket storm.
    const { connectIterateSession, useIterateSession, reconnectIterateSession } =
      await import("./itx-react.tsx");
    control.authError = new Error("handshake rejected for this principal");
    const first = connectIterateSession();
    FakeWebSocket.instances[0]!.fire("open");
    await expect(first).rejects.toThrow(/handshake rejected/);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Parked: repeated imperative connects return the SAME terminal failure
    // without dialing…
    expect(connectIterateSession()).toBe(first);
    await expect(connectIterateSession()).rejects.toThrow(/handshake rejected/);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // …and rendering (the storm vector: every render reads the snapshot) does
    // not dial either — the suspended tree surfaces the terminal error.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const [React, { createRoot }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
    ]);
    const { act, createElement, Component, Suspense } = React;
    function Probe() {
      useIterateSession();
      return null;
    }
    class Boundary extends Component<{ children?: unknown }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed
          ? createElement("output", { "data-state": "error" })
          : (this.props.children as ReturnType<typeof createElement>);
      }
    }
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          Boundary,
          null,
          createElement(Suspense, { fallback: null }, createElement(Probe)),
        ),
      );
    });
    expect(container.querySelector("output")?.getAttribute("data-state")).toBe("error");
    expect(FakeWebSocket.instances).toHaveLength(1); // still parked — render dialed nothing

    // Revival is explicit: the semantic reset dials fresh and recovers.
    control.authError = undefined;
    reconnectIterateSession();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const revived = connectIterateSession();
    expect(revived).not.toBe(first);
    await openLatest();
    await expect(revived).resolves.toBe(control.lastRoot);
    await act(async () => root.unmount());
    container.remove();
  });

  test("terminal auth on RECONNECT drops the dead session (no zombie stubs) and surfaces the error", async () => {
    // Authority loss mid-session: the live socket dies, the redial's
    // authenticate rejects terminally (claims revoked / signed out elsewhere).
    // Keeping the prior session would be a ZOMBIE — its transport is closed, so
    // hooks would serve stubs whose every call fails with transport-shaped
    // errors while the real auth error never surfaces.
    const { connectIterateSession, reconnectIterateSession } = await import("./itx-react.tsx");
    const first = connectIterateSession();
    await openLatest();
    const session = (await first) as unknown as { [Symbol.dispose]: ReturnType<typeof vi.fn> };

    control.authError = new Error("session revoked");
    FakeWebSocket.instances[0]!.fire("close"); // transport dies → auto-redial
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.fire("open"); // redial authenticates → terminal
    await expect(connectIterateSession()).rejects.toThrow(/session revoked/);

    // Parked, and the dead session was DROPPED + disposed — not handed out.
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);

    // Explicit reset with restored claims recovers to a fresh session.
    control.authError = undefined;
    reconnectIterateSession();
    await openLatest();
    await expect(connectIterateSession()).resolves.toBe(control.lastRoot);
  });

  test("a semantic reset clears dial backoff so new claims dial immediately", async () => {
    vi.useFakeTimers();
    try {
      const { connectIterateSession, reconnectIterateSession } = await import("./itx-react.tsx");
      connectIterateSession();
      FakeWebSocket.instances[0]!.fire("close"); // failure 1 → immediate re-dial
      FakeWebSocket.instances[1]!.fire("close"); // failure 2 → next dial is now paced
      expect(FakeWebSocket.instances).toHaveLength(2); // backoff: no socket yet
      // A deliberate reset (new claims after create/unlock) must dial NOW, not
      // inherit pacing from those earlier closed-before-open failures.
      reconnectIterateSession();
      expect(FakeWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reportTransportSuspicion leaves a HEALTHY socket alone (no false-positive reconnect)", async () => {
    const { connectIterateSession, reportTransportSuspicion } = await import("./itx-react.tsx");
    const first = connectIterateSession();
    await openLatest();
    await first;
    // The auth probe answers immediately (alive), so two-strike verification
    // keeps the socket: a busy-but-alive transport must not be torn down.
    reportTransportSuspicion();
    await vi.waitFor(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(connectIterateSession()).toBe(first);
  });

  test("reportTransportSuspicion re-dials a genuinely half-open socket after two strikes", async () => {
    vi.useFakeTimers();
    try {
      const { connectIterateSession, reportTransportSuspicion } = await import("./itx-react.tsx");
      const first = connectIterateSession();
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
      expect(connectIterateSession()).not.toBe(first);
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
  type TestHandle = {
    ping: () => boolean | Promise<boolean>;
    unsubscribe: () => void;
    [Symbol.dispose]?: () => void;
  };
  async function mountSubscription(
    makeHandle: () => TestHandle,
    wrapSubscribe?: (handle: TestHandle) => Promise<TestHandle>,
  ) {
    const [{ useItxSubscription, ProjectScope }, React, { createRoot }] = await Promise.all([
      import("./itx-react.tsx"),
      import("react"),
      import("react-dom/client"),
    ]);
    const { act, createElement } = React;

    const subscribe = vi.fn(async () => {
      const handle = makeHandle();
      return wrapSubscribe ? wrapSubscribe(handle) : handle;
    });
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

  test("teardown unsubscribes AND disposes the handle (no import-table leak)", async () => {
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const harness = await mountSubscription(() => ({
      ping: () => true,
      unsubscribe,
      [Symbol.dispose]: dispose,
    }));
    expect(harness.status()).toBe("live");
    await harness.unmount();
    await vi.advanceTimersByTimeAsync(0); // the dispose chain settles on microtasks
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("a NON-transport subscribe failure stays in error — never an infinite retry loop", async () => {
    const harness = await mountSubscription(() => {
      throw new Error("no such capability: liveState");
    });
    expect(harness.status()).toBe("error");
    expect(harness.subscribe).toHaveBeenCalledTimes(1);
    // A permanent failure must not silently retry every SUBSCRIBE_RETRY window.
    await harness.advance(60_000);
    expect(harness.subscribe).toHaveBeenCalledTimes(1);
  });

  test("a TRANSPORT-failed subscribe retries on the subscribe-retry delay", async () => {
    let attempts = 0;
    const harness = await mountSubscription(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("Peer closed WebSocket: 1006 ");
      return { ping: () => true, unsubscribe: vi.fn() };
    });
    expect(harness.status()).toBe("error");
    await harness.advance(10_000); // SUBSCRIBE_RETRY_MS
    expect(harness.subscribe).toHaveBeenCalledTimes(2);
    expect(harness.status()).toBe("live");
  });

  test("a run superseded mid-subscribe cannot flip state; its late handle is disposed", async () => {
    // The subscribe hangs until released; the component unmounts first. The late
    // resolution must be swallowed (no status write) and its handle released.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const harness = await mountSubscription(
      () => ({ ping: () => true, unsubscribe, [Symbol.dispose]: dispose }),
      async (handle) => {
        await gate;
        return handle;
      },
    );
    expect(harness.status()).toBe("connecting"); // still awaiting subscribe
    await harness.unmount();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("useLiveState drops its value when the AMBIENT ProjectScope slug changes (no cross-project stale state)", async () => {
    // The router does NOT remount route components on param-only navigation, so
    // /projects/a/... → /projects/b/... changes the ambient scope under a
    // mounted hook. Project A's state must never render under project B — the
    // node key includes the EFFECTIVE slug, so the switch resets + barriers.
    const [{ useLiveState, ProjectScope }, React, { createRoot }] = await Promise.all([
      import("./itx-react.tsx"),
      import("react"),
      import("react-dom/client"),
    ]);
    const { act, createElement } = React;

    // One captured update-sink per subscription; the test pushes snapshots.
    const sinks: Array<(update: unknown) => void> = [];
    const live = () => ({
      subscribe: async (onUpdate: (update: unknown) => void) => {
        sinks.push(onUpdate);
        return { ping: () => true, unsubscribe: vi.fn() };
      },
    });
    function Harness() {
      const { value } = useLiveState(live as never, (s: { name: string }) => s.name, []);
      return createElement("output", null, value ?? "∅");
    }

    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const rendered = () => container.querySelector("output")?.textContent;
    const renderScope = (slug: string) =>
      act(async () => {
        root.render(createElement(ProjectScope, { slug, children: createElement(Harness) }));
      });

    await renderScope("project-a");
    await act(async () => {
      FakeWebSocket.instances.at(-1)!.fire("open");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sinks).toHaveLength(1);
    await act(async () => {
      sinks[0]!({ type: "snapshot", revision: 0, state: { name: "alpha" } });
    });
    expect(rendered()).toBe("alpha");

    // Param-only navigation: same tree, new ambient slug. The held value must
    // drop IMMEDIATELY — never project A's state under project B.
    await renderScope("project-b");
    expect(rendered()).toBe("∅");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rendered()).toBe("∅"); // still nothing until B pushes
    expect(sinks).toHaveLength(2); // re-subscribed for project B
    await act(async () => {
      sinks[1]!({ type: "snapshot", revision: 0, state: { name: "beta" } });
    });
    expect(rendered()).toBe("beta");
    await act(async () => root.unmount());
    container.remove();
  });

  test("regaining connectivity while HIDDEN still checks (a backgrounded tab recovers)", async () => {
    let handles = 0;
    const harness = await mountSubscription(() => {
      handles += 1;
      const mine = handles;
      return { ping: () => mine > 1, unsubscribe: vi.fn() };
    });

    // Background the tab. A visibilitychange must NOT check while hidden…
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await harness.advance(0);
      expect(harness.subscribe).toHaveBeenCalledTimes(1);

      // …but `online` (the network came back) checks regardless of visibility, so
      // a half-open socket recovers without waiting for the tab to be focused.
      window.dispatchEvent(new Event("online"));
      await harness.advance(0);
      expect(harness.subscribe).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(document, "visibilityState"); // back to jsdom's default "visible"
      await harness.unmount();
    }
  });
});
