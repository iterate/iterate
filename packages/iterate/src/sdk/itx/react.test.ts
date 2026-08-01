// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Control the mock capnweb session from tests: `hangSessionProbe` makes the
// liveness `Session.__describe()` call hang, modelling a half-open transport
// whose root was already established.
// `authError` makes the FIRST authenticate reject (a terminal handshake
// failure); `lastRoot` is the session returned by the latest WebSocket connection.
const control = vi.hoisted(() => ({
  hangSessionProbe: false,
  hangFirstAuth: false,
  sessionProbeError: undefined as Error | undefined,
  sessionProbeCalls: 0,
  authenticateCalls: 0,
  authError: undefined as Error | undefined,
  authErrors: [] as Error[],
  lastRoot: undefined as unknown,
  lastRpcRootDispose: undefined as ReturnType<typeof vi.fn> | undefined,
  lastCredentials: undefined as unknown,
}));

// Mock the capnweb session so opening a connection returns a disposable sentinel keyed
// by the socket URL and the authenticate()/projects.get(slug) pipeline — we
// assert on identity/url, never a real RPC session. The FIRST authenticate()
// per socket models the RpcPromise: a THENABLE whose resolution is the real
// session handle — the code must await it and publish the RESOLVED identity
// (resolving a native promise with the thenable itself would assimilate).
// Liveness calls the resolved Session's __describe(), never authenticate again.
vi.mock("@iterate-com/capnweb", () => ({
  newWebSocketRpcSession: (ws: { url: string }) => {
    const pendingCalls = new Set<PromiseWithResolvers<never>>();
    const disposeRpcRoot = vi.fn(() => {
      const error = new Error("RPC session was shut down by disposing the main stub");
      for (const pending of pendingCalls) pending.reject(error);
      pendingCalls.clear();
    });
    control.lastRpcRootDispose = disposeRpcRoot;
    return {
      [Symbol.dispose]: disposeRpcRoot,
      authenticate: (credentials?: unknown) => {
        control.authenticateCalls += 1;
        control.lastCredentials = credentials;
        const handleFor = (suffix: string) => {
          const handle = {
            url: suffix ? `${ws.url}/${suffix}` : ws.url,
            [Symbol.dispose]: vi.fn(),
            dup: () => handle,
          };
          return handle;
        };
        if (control.hangFirstAuth) return new Promise(() => {});
        const queuedAuthError = control.authErrors.shift();
        if (queuedAuthError) return Promise.reject(queuedAuthError);
        if (control.authError) return Promise.reject(control.authError);
        const root = Object.assign(handleFor(""), {
          __describe: () => {
            control.sessionProbeCalls += 1;
            if (control.hangSessionProbe) return new Promise(() => {});
            if (control.sessionProbeError) return Promise.reject(control.sessionProbeError);
            return { principal: "test" };
          },
          hang: () => {
            const pending = Promise.withResolvers<never>();
            pendingCalls.add(pending);
            return pending.promise;
          },
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
  input: string | URL;
  url: string;
  closeEmitsEvent = true;
  private handlers: Record<string, Array<() => void>> = {};
  constructor(url: string | URL) {
    this.input = url;
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: () => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  close() {
    if (this.closeEmitsEvent) this.fire("close");
  }
  fire(type: string) {
    for (const cb of this.handlers[type] ?? []) cb();
  }
}

beforeEach(() => {
  control.hangSessionProbe = false;
  control.hangFirstAuth = false;
  control.sessionProbeError = undefined;
  control.sessionProbeCalls = 0;
  control.authenticateCalls = 0;
  control.authError = undefined;
  control.authErrors = [];
  control.lastRoot = undefined;
  control.lastRpcRootDispose = undefined;
  control.lastCredentials = undefined;
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
    const { connectIterateSession } = await import("./react.ts");
    const a = connectIterateSession();
    expect(connectIterateSession()).toBe(a); // one connection attempt, the stable promise use() needs
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onlySocket().url).toContain("/api");
    await openLatest();
    await expect(a).resolves.toMatchObject({ url: expect.stringContaining("/api") });
  });

  test("connectItx narrows the ONE session to a project stub — no second socket", async () => {
    const { connectIterateSession, connectItx } = await import("./react.ts");
    const session = connectIterateSession(); // connects the one socket
    await openLatest();
    const acme = await connectItx("acme");
    const other = await connectItx("prj_123");
    // Both project handles ride the ONE socket the session connected.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(acme).toMatchObject({ url: expect.stringContaining("/api/acme") });
    expect(other).toMatchObject({ url: expect.stringContaining("/api/prj_123") });
    await expect(session).resolves.toMatchObject({ url: expect.stringContaining("/api") });
  });

  test("a connection attempt that closes before opening rejects awaiters instead of hanging, then reconnects", async () => {
    const { connectIterateSession } = await import("./react.ts");
    const first = connectIterateSession();
    onlySocket().fire("close"); // closed before it ever opened
    await expect(first).rejects.toThrow(/closed before connecting/);
    // The entry was dropped, so the next call opens a fresh socket.
    const second = connectIterateSession();
    expect(second).not.toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("INVISIBLE RECONNECT: a live session survives a transport gap and auto-reconnects", async () => {
    const { connectIterateSession } = await import("./react.ts");
    const first = connectIterateSession();
    await openLatest();
    const session = await first;

    // Transport dies AFTER being live: the socket is auto-reconnected and the last
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
    const { connectIterateSession, reconnectIterateSession } = await import("./react.ts");
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
    const { connectIterateSession, reconnectIterateSession } = await import("./react.ts");
    const superseded = connectIterateSession();
    reconnectIterateSession(); // supersede the first connection attempt before it ever opened
    await expect(superseded).rejects.toThrow(/closed before connecting/);
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
    // The probe rejects with a non-transport error: the transport
    // is alive, so two 10s windows must NOT retire the socket.
    vi.useFakeTimers();
    try {
      const { connectIterateSession, reportTransportSuspicion } = await import("./react.ts");
      const first = connectIterateSession();
      FakeWebSocket.instances[0]!.fire("open");
      await vi.advanceTimersByTimeAsync(0);
      await first;

      control.sessionProbeError = new Error("permission denied"); // NOT a transport error
      reportTransportSuspicion();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(connectIterateSession()).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  test("repeated closed-before-open connects get backoff from the SECOND consecutive failure", async () => {
    vi.useFakeTimers();
    try {
      const { connectIterateSession } = await import("./react.ts");
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

  test("isItxTransportError classifies exactly the four transport signatures", async () => {
    const { isItxTransportError } = await import("./react.ts");
    expect(isItxTransportError(new Error("itx WebSocket closed before connecting"))).toBe(true);
    expect(isItxTransportError(new Error("Peer closed WebSocket: 1006 "))).toBe(true);
    expect(isItxTransportError(new Error("WebSocket connection failed."))).toBe(true);
    expect(
      isItxTransportError(new Error("RPC session was shut down by disposing the main stub")),
    ).toBe(true);
    // An application error that merely MENTIONS WebSocket is not a transport close.
    expect(isItxTransportError(new Error("WebSocket subscriptions require admin"))).toBe(false);
    expect(isItxTransportError(new Error("permission denied"))).toBe(false);
  });

  test("configureIterateSession connects the configured deployment with the given credentials", async () => {
    // Non-browser callers (TUI, keeper-based scripts) provide an explicit base URL +
    // credentials replace the window-derived /api + cookie default.
    const { configureIterateSession, connectIterateSession } = await import("./react.ts");
    configureIterateSession({
      baseUrl: "https://os.example.com/",
      credentials: { type: "admin-secret", secret: "s3cr3t" },
    });
    const { reportTransportSuspicion } = await import("./react.ts");
    const first = connectIterateSession();
    // React Native's WebSocket forwards this argument into an iOS TurboModule
    // method typed as a string; unlike browsers and Node, it rejects URL objects.
    expect(typeof onlySocket().input).toBe("string");
    expect(onlySocket().url).toBe("wss://os.example.com/api");
    await openLatest();
    await first;
    expect(control.lastCredentials).toEqual({ type: "admin-secret", secret: "s3cr3t" });
    expect(control.authenticateCalls).toBe(1);

    // Liveness probes the already-authorized Session capability. It must not
    // present credentials (and hit auth) every 45 seconds merely to test the
    // transport.
    reportTransportSuspicion();
    await vi.waitFor(() => {
      expect(control.sessionProbeCalls).toBe(1);
    });
    expect(control.authenticateCalls).toBe(1);
  });

  test("configured credentials are resolved for each dial and force-refreshed once after an auth rejection", async () => {
    const { configureIterateSession, connectIterateSession } = await import("./react.ts");
    const requests: Array<{ forceRefresh: boolean }> = [];
    configureIterateSession({
      baseUrl: "https://os.example.com",
      credentials: ({ forceRefresh }) => {
        requests.push({ forceRefresh });
        return { type: "bearer", token: forceRefresh ? "fresh" : "cached" };
      },
    });
    control.authErrors.push(new Error("token expired"));

    const session = connectIterateSession();
    await openLatest();
    await expect(session).resolves.toMatchObject({ url: "wss://os.example.com/api" });
    expect(requests).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
    expect(control.lastCredentials).toEqual({ type: "bearer", token: "fresh" });
    expect(control.authenticateCalls).toBe(2);

    FakeWebSocket.instances[0]!.fire("close");
    await openLatest();
    await connectIterateSession();
    expect(requests).toEqual([
      { forceRefresh: false },
      { forceRefresh: true },
      { forceRefresh: false },
    ]);
  });

  test("configureIterateSession keeps the same target stable and replaces a different deployment", async () => {
    const { configureIterateSession, connectIterateSession } = await import("./react.ts");
    configureIterateSession({ baseUrl: "https://os.example.com" });
    const first = connectIterateSession();
    await openLatest();
    const firstSession = await first;

    configureIterateSession({ baseUrl: "https://os.example.com/" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(connectIterateSession()).toBe(first);

    configureIterateSession({ baseUrl: "https://elsewhere.example" });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.url).toBe("wss://elsewhere.example/api");
    expect(firstSession[Symbol.dispose]).toHaveBeenCalledTimes(1);
    await openLatest();
    await expect(connectIterateSession()).resolves.toMatchObject({
      url: "wss://elsewhere.example/api",
    });
  });

  test("disconnectIterateSession releases the current authority and leaves the keeper idle", async () => {
    const { configureIterateSession, connectIterateSession, disconnectIterateSession } =
      await import("./react.ts");
    configureIterateSession({ baseUrl: "https://os.example.com" });
    const first = connectIterateSession();
    await openLatest();
    const session = await first;

    disconnectIterateSession();
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const second = connectIterateSession();
    expect(FakeWebSocket.instances).toHaveLength(2);
    await openLatest();
    await expect(second).resolves.toMatchObject({ url: "wss://os.example.com/api" });
  });

  test("FIRST-LOAD SUSPENSE survives a closed-before-open connection attempt — never the error boundary", async () => {
    // A suspended (never-committed) component replays against the thenable it
    // first used, so a rejected individual attempt would surface in the error
    // boundary even though a paced reconnect is underway. use() must therefore
    // suspend on the STABLE first-connect promise. Also locks session identity:
    // the hook and the imperative path must hand out the SAME resolved stub.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const [{ useIterateSession, connectIterateSession }, React, { createRoot }] = await Promise.all(
      [import("./react.ts"), import("react"), import("react-dom/client")],
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
    expect(state()).toBe("loading"); // suspended on the first connection attempt

    // The connection attempt dies before opening: its promise rejects (imperative
    // awaiters fail fast) but the suspended tree must stay suspended.
    await act(async () => {
      FakeWebSocket.instances[0]!.fire("close");
    });
    expect(state()).toBe("loading");
    expect(FakeWebSocket.instances).toHaveLength(2); // reconnected immediately

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

  test("the connection attempt timeout spans authenticate and reconnects without waiting for a close event", async () => {
    // A server that accepts the WebSocket but never answers authenticate must
    // be a FAILED connection attempt (close → paced reconnect), not an infinite spinner.
    vi.useFakeTimers();
    try {
      const { connectIterateSession } = await import("./react.ts");
      control.hangFirstAuth = true;
      const first = connectIterateSession();
      FakeWebSocket.instances[0]!.closeEmitsEvent = false;
      FakeWebSocket.instances[0]!.fire("open"); // opens, then authenticate hangs
      await vi.advanceTimersByTimeAsync(15_000); // DIAL_TIMEOUT_MS
      await expect(first).rejects.toThrow(/closed before connecting/);
      // The timeout itself transferred ownership; the wedged socket never
      // acknowledged close, so a close-handler-owned retry would hang here.
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

  test("a terminal authenticate rejection halts reconnects until an explicit reset", async () => {
    // A real auth answer over a working socket is terminal. The failed
    // generation must keep owning the slot: renders re-read the snapshot (which
    // connects when the slot is empty) and the failure's own setState re-renders —
    // clearing the slot here would be an unbounded WebSocket storm.
    const { connectIterateSession, useIterateSession, reconnectIterateSession } =
      await import("./react.ts");
    control.authError = new Error("handshake rejected for this principal");
    const first = connectIterateSession();
    FakeWebSocket.instances[0]!.fire("open");
    await expect(first).rejects.toThrow(/handshake rejected/);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Halted: repeated imperative connects return the SAME terminal failure
    // without connecting…
    expect(connectIterateSession()).toBe(first);
    await expect(connectIterateSession()).rejects.toThrow(/handshake rejected/);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // …and rendering (the storm vector: every render reads the snapshot) does
    // not connection attempt either — the suspended tree surfaces the terminal error.
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
    expect(FakeWebSocket.instances).toHaveLength(1); // still halted — render connected nothing

    // Revival is explicit: the semantic reset connects fresh and recovers.
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

  test("an imperative retry revives a parked terminal auth failure", async () => {
    const { connectIterateSession, retryFailedIterateSession } = await import("./react.ts");
    control.authError = new Error("session token expired");
    const first = connectIterateSession();
    FakeWebSocket.instances[0]!.fire("open");
    await expect(first).rejects.toThrow(/token expired/);

    control.authError = undefined;
    retryFailedIterateSession();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const retried = connectIterateSession();
    await openLatest();
    await expect(retried).resolves.toBe(control.lastRoot);
  });

  test("terminal auth on RECONNECT drops the dead session (no zombie stubs) and surfaces the error", async () => {
    // Authority loss mid-session: the live socket dies, the reconnect's
    // authenticate rejects terminally (claims revoked / signed out elsewhere).
    // Keeping the prior session would be a ZOMBIE — its transport is closed, so
    // hooks would serve stubs whose every call fails with transport-shaped
    // errors while the real auth error never surfaces.
    const { connectIterateSession, reconnectIterateSession } = await import("./react.ts");
    const first = connectIterateSession();
    await openLatest();
    const session = (await first) as unknown as { [Symbol.dispose]: ReturnType<typeof vi.fn> };

    control.authError = new Error("session revoked");
    FakeWebSocket.instances[0]!.fire("close"); // transport dies → auto-reconnect
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.fire("open"); // reconnect authenticates → terminal
    await expect(connectIterateSession()).rejects.toThrow(/session revoked/);

    // Halted, and the dead session was DROPPED + disposed — not handed out.
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(session[Symbol.dispose]).toHaveBeenCalledTimes(1);

    // Explicit reset with restored claims recovers to a fresh session.
    control.authError = undefined;
    reconnectIterateSession();
    await openLatest();
    await expect(connectIterateSession()).resolves.toBe(control.lastRoot);
  });

  test("a semantic reset clears the retry delay so new claims reconnect immediately", async () => {
    vi.useFakeTimers();
    try {
      const { connectIterateSession, reconnectIterateSession } = await import("./react.ts");
      connectIterateSession();
      FakeWebSocket.instances[0]!.fire("close"); // failure 1 → immediate reconnect
      FakeWebSocket.instances[1]!.fire("close"); // failure 2 → next connection attempt is now paced
      expect(FakeWebSocket.instances).toHaveLength(2); // backoff: no socket yet
      // A deliberate reset (new claims after create/unlock) must reconnect now, not
      // inherit pacing from those earlier closed-before-open failures.
      reconnectIterateSession();
      expect(FakeWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reportTransportSuspicion leaves a HEALTHY socket alone (no false-positive reconnect)", async () => {
    const { connectIterateSession, reportTransportSuspicion } = await import("./react.ts");
    const first = connectIterateSession();
    await openLatest();
    await first;
    // The Session probe answers immediately (alive), so two-strike verification
    // keeps the socket: a busy-but-alive transport must not be torn down.
    reportTransportSuspicion();
    await vi.waitFor(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(connectIterateSession()).toBe(first);
  });

  test("reportTransportSuspicion reconnects a genuinely half-open socket after two strikes", async () => {
    vi.useFakeTimers();
    try {
      const { connectIterateSession, reportTransportSuspicion } = await import("./react.ts");
      const first = connectIterateSession();
      FakeWebSocket.instances[0]!.fire("open");
      await vi.advanceTimersByTimeAsync(0);
      const session = (await first) as unknown as { hang(): Promise<never> };
      const pendingCall = session.hang();
      const pendingRejection = expect(pendingCall).rejects.toThrow(
        /RPC session was shut down by disposing the main stub/,
      );

      // The transport goes half-open: probes and even WebSocket.close() now
      // hang. Two 10s strikes must still abort capnweb (settling the in-flight
      // call) and transfer ownership to a fresh generation.
      FakeWebSocket.instances[0]!.closeEmitsEvent = false;
      control.hangSessionProbe = true;
      reportTransportSuspicion();
      await vi.advanceTimersByTimeAsync(10_000); // strike one
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000); // strike two → reconnect
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(control.lastRpcRootDispose).toHaveBeenCalledTimes(1);
      await pendingRejection;
      expect(connectIterateSession()).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProjectScope", () => {
  test("renders on the server without trying to connect", async () => {
    const [{ ProjectScope }, React, { renderToString }] = await Promise.all([
      import("./react.ts"),
      import("react"),
      import("react-dom/server"),
    ]);

    const html = renderToString(
      React.createElement(
        ProjectScope,
        { slug: "acme" },
        React.createElement("main", null, "acme"),
      ),
    );

    expect(html).toBe("<main>acme</main>");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

// The liveness watchdog is module-private; these tests drive it through the
// public useStreamConnection hook with a real React tree — which also covers the
// epoch/reopen integration the bare watchdog can't show.
describe("useStreamConnection liveness", () => {
  const INTERVAL = 45_000;
  const PING_TIMEOUT = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => vi.useRealTimers());

  /**
   * Mount a component holding one useStreamConnection, under a <ProjectScope> so
   * the ambient project resolves. Everything is imported AFTER the file-level
   * vi.resetModules() so the harness's React instance is the one itx-react
   * loaded (a static import would be a different copy — invalid-hook-call).
   */
  type TestHandle = {
    ping: () => boolean | Promise<boolean>;
    close: () => void;
    [Symbol.dispose]?: () => void;
  };
  async function mountConnection(
    makeHandle: () => TestHandle,
    wrapOpen?: (handle: TestHandle) => Promise<TestHandle>,
  ) {
    const [{ useStreamConnection, ProjectScope }, React, { createRoot }] = await Promise.all([
      import("./react.ts"),
      import("react"),
      import("react-dom/client"),
    ]);
    const { act, createElement } = React;

    const open = vi.fn(async () => {
      const handle = makeHandle();
      return wrapOpen ? wrapOpen(handle) : handle;
    });
    function Harness() {
      const connection = useStreamConnection(open as never, []);
      return createElement("output", { "data-status": connection.status });
    }

    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ProjectScope, { slug: "acme" }, createElement(Harness)));
    });
    // The hook awaits the connection inside its effect (never suspends); open
    // the socket and let the effect + async open settle.
    await act(async () => {
      FakeWebSocket.instances.at(-1)!.fire("open");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    return {
      open,
      status: () => container.querySelector("output")?.getAttribute("data-status"),
      advance: (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms)),
      act: (fn: () => void) =>
        act(async () => {
          fn();
          await vi.advanceTimersByTimeAsync(0);
        }),
      unmount: () => act(async () => root.unmount()),
    };
  }

  test("a connection that keeps answering true stays live and is left alone", async () => {
    let pings = 0;
    const harness = await mountConnection(() => ({
      ping: () => {
        pings += 1;
        return true;
      },
      close: vi.fn(),
    }));

    expect(harness.status()).toBe("live");
    await harness.advance(INTERVAL * 3);
    expect(pings).toBe(3);
    expect(harness.open).toHaveBeenCalledTimes(1); // never reopened
    expect(harness.status()).toBe("live");
    await harness.unmount();
  });

  test("a socket close reconnects and reopens the event connection", async () => {
    const harness = await mountConnection(() => ({
      ping: () => true,
      close: vi.fn(),
    }));
    const firstSocket = FakeWebSocket.instances.at(-1)!;

    expect(harness.status()).toBe("live");
    await harness.act(() => firstSocket.fire("close"));
    const secondSocket = FakeWebSocket.instances.at(-1)!;
    expect(secondSocket).not.toBe(firstSocket); // auto-reconnected

    await harness.act(() => secondSocket.fire("open"));
    await harness.advance(0);
    expect(harness.open).toHaveBeenCalledTimes(2); // fresh generation reopened
    expect(harness.status()).toBe("live");
    await harness.unmount();
  });

  test("an open call that never settles times out, reports suspicion, and retries", async () => {
    // A transport can disappear after the server accepted the open but before
    // the handle arrives — no handle means no watchdog, so without the timeout
    // the UI would sit "connecting" forever. The hook REPORTS the suspicion
    // (the verifier probes; here the mock answers alive, so the healthy socket
    // is left alone) and retries after the connection retry delay.
    let attempts = 0;
    const harness = await mountConnection(
      () => ({ ping: () => true, close: vi.fn() }),
      async (handle) => {
        attempts += 1;
        if (attempts === 1) return new Promise<never>(() => {}); // never settles
        return handle;
      },
    );

    expect(harness.status()).toBe("connecting");
    await harness.advance(15_000); // CONNECTION_TIMEOUT_MS
    expect(harness.status()).toBe("connecting");
    expect(FakeWebSocket.instances).toHaveLength(1); // alive socket NOT torn down

    await harness.advance(10_000); // CONNECTION_RETRY_MS
    expect(harness.open).toHaveBeenCalledTimes(2);
    expect(harness.status()).toBe("live");
    await harness.unmount();
  });

  test("ping answering false (server-side connection gone) reopens it", async () => {
    let handles = 0;
    const harness = await mountConnection(() => {
      handles += 1;
      const mine = handles;
      return { ping: () => mine > 1, close: vi.fn() };
    });

    expect(harness.status()).toBe("live");
    await harness.advance(INTERVAL);
    expect(harness.open).toHaveBeenCalledTimes(2); // recovered via a fresh open
    expect(harness.status()).toBe("live");
    await harness.advance(INTERVAL * 2);
    expect(harness.open).toHaveBeenCalledTimes(2); // and then left alone
    await harness.unmount();
  });

  test("a rejecting ping (dead DO incarnation) reopens the connection", async () => {
    let handles = 0;
    const harness = await mountConnection(() => {
      handles += 1;
      const mine = handles;
      return {
        ping: () => (mine > 1 ? true : Promise.reject(new Error("Durable Object reset"))),
        close: vi.fn(),
      };
    });

    await harness.advance(INTERVAL);
    expect(harness.open).toHaveBeenCalledTimes(2);
    expect(harness.status()).toBe("live");
    await harness.unmount();
  });

  test("a hanging ping (silent death) reopens and reports transport suspicion", async () => {
    let handles = 0;
    const harness = await mountConnection(() => {
      handles += 1;
      const mine = handles;
      // The FIRST handle's ping hangs; its replacement answers, so recovery is a
      // reopen on the (healthy, per the mock) transport.
      return {
        ping: () => (mine > 1 ? true : new Promise<boolean>(() => {})),
        close: vi.fn(),
      };
    });

    // TWO ping timeouts (two-strike): after the FIRST nothing recovers yet.
    await harness.advance(INTERVAL + PING_TIMEOUT);
    expect(harness.open).toHaveBeenCalledTimes(1);
    await harness.advance(PING_TIMEOUT);
    expect(harness.open).toHaveBeenCalledTimes(2);
    expect(harness.status()).toBe("live");
    await harness.unmount();
  });

  test("the tab becoming visible triggers an immediate liveness check", async () => {
    let handles = 0;
    const harness = await mountConnection(() => {
      handles += 1;
      const mine = handles;
      return { ping: () => mine > 1, close: vi.fn() };
    });

    document.dispatchEvent(new Event("visibilitychange"));
    await harness.advance(0);
    expect(harness.open).toHaveBeenCalledTimes(2);
    await harness.unmount();
  });

  test("teardown closes AND disposes the handle (no import-table leak)", async () => {
    const close = vi.fn();
    const dispose = vi.fn();
    const harness = await mountConnection(() => ({
      ping: () => true,
      close,
      [Symbol.dispose]: dispose,
    }));
    expect(harness.status()).toBe("live");
    await harness.unmount();
    await vi.advanceTimersByTimeAsync(0); // the dispose chain settles on microtasks
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("a NON-transport open failure stays in error — never an infinite retry loop", async () => {
    const harness = await mountConnection(() => {
      throw new Error("no such capability: liveState");
    });
    expect(harness.status()).toBe("error");
    expect(harness.open).toHaveBeenCalledTimes(1);
    // A permanent failure must not silently retry every CONNECTION_RETRY window.
    await harness.advance(60_000);
    expect(harness.open).toHaveBeenCalledTimes(1);
  });

  test("a transport-failed open retries after the connection retry delay", async () => {
    let attempts = 0;
    const harness = await mountConnection(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("Peer closed WebSocket: 1006 ");
      return { ping: () => true, close: vi.fn() };
    });
    expect(harness.status()).toBe("connecting");
    await harness.advance(10_000); // CONNECTION_RETRY_MS
    expect(harness.open).toHaveBeenCalledTimes(2);
    expect(harness.status()).toBe("live");
  });

  test("a run superseded while opening cannot flip state; its late handle is released", async () => {
    // The open hangs until released; the component unmounts first. The late
    // resolution must be swallowed (no status write) and its handle released.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const close = vi.fn();
    const dispose = vi.fn();
    const harness = await mountConnection(
      () => ({ ping: () => true, close, [Symbol.dispose]: dispose }),
      async (handle) => {
        await gate;
        return handle;
      },
    );
    expect(harness.status()).toBe("connecting"); // still awaiting open
    await harness.unmount();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("useLiveState drops its value when the AMBIENT ProjectScope slug changes (no cross-project stale state)", async () => {
    // The router does NOT remount route components on param-only navigation, so
    // /projects/a/... → /projects/b/... changes the ambient scope under a
    // mounted hook. Project A's state must never render under project B — the
    // node key includes the EFFECTIVE slug, so the switch resets + barriers.
    const [{ useLiveState, ProjectScope }, React, { createRoot }] = await Promise.all([
      import("./react.ts"),
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
        root.render(createElement(ProjectScope, { slug }, createElement(Harness)));
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

  test("useIterateSessionLiveState is inert while disabled and resets when its node changes", async () => {
    const [{ useIterateSessionLiveState }, React, { createRoot }] = await Promise.all([
      import("./react.ts"),
      import("react"),
      import("react-dom/client"),
    ]);
    const { act, createElement } = React;
    const sinks: Array<(update: unknown) => void> = [];
    const unsubscribe = vi.fn();
    const roots: unknown[] = [];
    let enabled = false;
    let node = "a";

    function Harness() {
      const { status, value } = useIterateSessionLiveState(
        (session) => {
          roots.push(session);
          return {
            subscribe: async (onUpdate: (update: unknown) => void) => {
              sinks.push(onUpdate);
              return { ping: () => true, unsubscribe };
            },
          } as never;
        },
        (state: { name: string }) => state.name,
        [node],
        { enabled },
      );
      return createElement("output", { "data-status": status }, value ?? "∅");
    }

    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const render = () => act(async () => root.render(createElement(Harness)));
    const rendered = () => container.querySelector("output")?.textContent;

    await render();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(rendered()).toBe("∅");

    enabled = true;
    await render();
    await act(async () => FakeWebSocket.instances.at(-1)!.fire("open"));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(roots).toEqual([control.lastRoot]);
    expect(sinks).toHaveLength(1);
    await act(async () => {
      sinks[0]!({ type: "snapshot", revision: 0, state: { name: "alpha" } });
    });
    expect(rendered()).toBe("alpha");

    node = "b";
    await render();
    expect(rendered()).toBe("∅");
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(sinks).toHaveLength(2);
    await act(async () => {
      sinks[1]!({ type: "snapshot", revision: 0, state: { name: "beta" } });
    });
    expect(rendered()).toBe("beta");

    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    container.remove();
  });

  test("regaining connectivity while HIDDEN still checks (a backgrounded tab recovers)", async () => {
    let handles = 0;
    const harness = await mountConnection(() => {
      handles += 1;
      const mine = handles;
      return { ping: () => mine > 1, close: vi.fn() };
    });

    // Background the tab. A visibilitychange must NOT check while hidden…
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await harness.advance(0);
      expect(harness.open).toHaveBeenCalledTimes(1);

      // …but `online` (the network came back) checks regardless of visibility, so
      // a half-open socket recovers without waiting for the tab to be focused.
      window.dispatchEvent(new Event("online"));
      await harness.advance(0);
      expect(harness.open).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(document, "visibilityState"); // back to jsdom's default "visible"
      await harness.unmount();
    }
  });
});
