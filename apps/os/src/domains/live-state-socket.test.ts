// The liveState-socket lane against fake sockets: the token gate, the
// read-at-flush-time flusher, the skipped-assembly reload, and the worker
// relay's seed/degrade/release races — unit-tested without a Durable Object.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdate } from "iterate/sdk/capnweb";
import {
  LiveStateSockets,
  dialLiveStateSocket,
  liveStateSocketLaneKey,
  liveStateSocketLaneTag,
  openRelayedLiveState,
  parseLiveStateSocketFrame,
  parseLiveStateSocketLaneTag,
  LIVE_STATE_SOCKET_HEADER,
} from "./live-state-socket.ts";

type FakeSocket = WebSocket & {
  sent: string[];
  closed: { code?: number; reason?: string }[];
};

function fakeSocket(): FakeSocket {
  const socket = {
    sent: [] as string[],
    closed: [] as { code?: number; reason?: string }[],
    send(data: string) {
      socket.sent.push(data);
    },
    close(code?: number, reason?: string) {
      socket.closed.push({ code, reason });
    },
  } as unknown as FakeSocket;
  return socket;
}

/** `WebSocketPair` is a workerd global; the upgrade path needs one to exist. */
function withWebSocketPair(): void {
  (globalThis as Record<string, unknown>).WebSocketPair ??= class {
    0 = fakeSocket();
    1 = fakeSocket();
  };
}

function socketsOver(input: {
  sockets: FakeSocket[];
  readState?: () => unknown;
  refresh?: () => void | PromiseLike<void>;
}) {
  const waits: Promise<unknown>[] = [];
  const host = new LiveStateSockets({
    getWebSockets: () => input.sockets.filter((socket) => socket.closed.length === 0),
    acceptWebSocket: () => undefined,
    readState: input.readState ?? (() => ({})),
    refresh: input.refresh ?? (() => undefined),
    waitUntil: (work) => {
      waits.push(work);
    },
  });
  return { host, waits };
}

describe("LiveStateSockets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores requests without the lane header so hosts fall through", async () => {
    const { host } = socketsOver({ sockets: [] });
    const response = await host.acceptUpgrade(new Request("https://x.internal/"));
    expect(response).toBeUndefined();
  });

  it("claims a lane-headed request without a WebSocket upgrade: 400, never a fall-through", async () => {
    const { host } = socketsOver({ sockets: [] });
    const response = await host.acceptUpgrade(
      new Request("https://x.internal/", {
        headers: { [LIVE_STATE_SOCKET_HEADER]: "watch" },
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("coalesces flushes and reads state at flush time, not schedule time", () => {
    const watcher = fakeSocket();
    let state = { n: 1 };
    const { host } = socketsOver({ sockets: [watcher], readState: () => state });

    host.scheduleFlush();
    host.scheduleFlush();
    state = { n: 2 }; // mutation lands between schedule and flush
    vi.runAllTimers();

    expect(watcher.sent).toHaveLength(1); // burst coalesced into one frame
    expect(parseLiveStateSocketFrame(watcher.sent[0])).toEqual({ state: { n: 2 } });

    host.scheduleFlush();
    vi.runAllTimers();
    expect(watcher.sent).toHaveLength(2); // the timer re-arms after each flush
  });

  it("schedules nothing without watchers", () => {
    const { host } = socketsOver({ sockets: [] });
    host.scheduleFlush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes on a real assembly and reloads once on a runner-wall skip", async () => {
    const watcher = fakeSocket();
    let refreshes = 0;
    const { host, waits } = socketsOver({
      sockets: [watcher],
      readState: () => ({ fresh: true }),
      refresh: () => {
        refreshes += 1;
      },
    });

    // Skipped assemblies while watchers exist: load every runner ONCE.
    host.refreshAfterAssembly({ skippedUnloadedRunners: true });
    host.refreshAfterAssembly({ skippedUnloadedRunners: true });
    await Promise.all(waits);
    expect(refreshes).toBe(1);

    // A real assembly just flushes.
    host.refreshAfterAssembly({ skippedUnloadedRunners: false });
    vi.runAllTimers();
    expect(watcher.sent).toHaveLength(1);
  });

  it("does nothing for skipped assemblies without watchers", async () => {
    let refreshes = 0;
    const { host, waits } = socketsOver({
      sockets: [],
      refresh: () => {
        refreshes += 1;
      },
    });
    host.refreshAfterAssembly({ skippedUnloadedRunners: true });
    await Promise.all(waits);
    expect(refreshes).toBe(0);
  });

  // Every way this host can fail to push correct state has ONE recovery: drop
  // the watchers so the relay re-dials and re-seeds. A watcher left attached
  // after a failed push is stale forever with nothing to say so.
  it("drops watchers when the runner-wall reload fails, instead of leaving them stale", async () => {
    const watcher = fakeSocket();
    const { host, waits } = socketsOver({
      sockets: [watcher],
      refresh: () => Promise.reject(new Error("runner load failed")),
    });

    host.refreshAfterAssembly({ skippedUnloadedRunners: true });
    await Promise.all(waits);

    expect(watcher.sent).toEqual([]);
    expect(watcher.closed).toEqual([{ code: 1011, reason: "runner reload failed" }]);
  });

  it("drops watchers when the seed refresh fails", async () => {
    withWebSocketPair();
    const watcher = fakeSocket();
    const { host, waits } = socketsOver({
      sockets: [watcher],
      refresh: () => Promise.reject(new Error("cold load failed")),
    });

    // The seed work is registered before the 101 is built, so the drop still
    // happens under Node, whose `Response` rejects status 101 (workerd allows
    // it — the upgrade itself is covered by the e2e lane).
    await host
      .acceptUpgrade(
        new Request("https://x.internal/", {
          headers: { Upgrade: "websocket", [LIVE_STATE_SOCKET_HEADER]: "watch" },
        }),
      )
      .catch(() => undefined);
    await Promise.all(waits);

    expect(watcher.closed).toEqual([{ code: 1011, reason: "seed refresh failed" }]);
  });

  it("drops only the watcher whose frame could not be sent", async () => {
    const healthy = fakeSocket();
    const broken = fakeSocket();
    broken.send = () => {
      // Stands in for the platform rejecting the frame — an oversized
      // full-state message is the realistic case.
      throw new Error("message too large");
    };
    const { host } = socketsOver({ sockets: [healthy, broken] });

    host.scheduleFlush();
    vi.runAllTimers();

    expect(healthy.sent).toHaveLength(1);
    expect(healthy.closed).toEqual([]);
    expect(broken.closed).toEqual([{ code: 1011, reason: "frame send failed" }]);
  });

  it("drops watchers when the state cannot be serialized", () => {
    const watcher = fakeSocket();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { host } = socketsOver({ sockets: [watcher], readState: () => cyclic });

    host.scheduleFlush();
    vi.runAllTimers();

    expect(watcher.sent).toEqual([]);
    expect(watcher.closed).toEqual([{ code: 1011, reason: "state could not be serialized" }]);
  });

  // refreshThenFlush is the trigger for hosts whose state lives OUTSIDE the
  // Durable Object (the stream's facet lanes): refresh pulls into a cache the
  // flusher then reads.
  describe("refreshThenFlush", () => {
    it("refreshes before flushing, so the frame carries post-refresh state", async () => {
      const watcher = fakeSocket();
      let state = { n: 1 };
      const { host, waits } = socketsOver({
        sockets: [watcher],
        readState: () => state,
        refresh: () => {
          state = { n: 2 };
        },
      });

      host.refreshThenFlush();
      await Promise.all(waits);
      vi.runAllTimers();

      expect(watcher.sent).toHaveLength(1);
      expect(parseLiveStateSocketFrame(watcher.sent[0])).toEqual({ state: { n: 2 } });
    });

    it("re-runs the refresh for a trigger landing mid-refresh, once per burst", async () => {
      const watcher = fakeSocket();
      let refreshes = 0;
      const gates: (() => void)[] = [];
      const { host, waits } = socketsOver({
        sockets: [watcher],
        readState: () => ({ refreshes }),
        refresh: () =>
          new Promise<void>((resolve) => {
            refreshes += 1;
            gates.push(resolve);
          }),
      });

      host.refreshThenFlush();
      // Two more triggers while the first refresh is in flight: their change
      // may postdate the in-flight read, so ONE more refresh must follow —
      // but only one (they coalesce).
      host.refreshThenFlush();
      host.refreshThenFlush();
      expect(refreshes).toBe(1);
      gates[0]!();
      await Promise.resolve();
      expect(refreshes).toBe(2);
      gates[1]!();
      await Promise.all(waits);
      vi.runAllTimers();

      expect(refreshes).toBe(2);
      expect(watcher.sent).toHaveLength(1);
      expect(parseLiveStateSocketFrame(watcher.sent[0])).toEqual({ state: { refreshes: 2 } });
    });

    it("does nothing without watchers", async () => {
      let refreshes = 0;
      const { host, waits } = socketsOver({
        sockets: [],
        refresh: () => {
          refreshes += 1;
        },
      });
      host.refreshThenFlush();
      await Promise.all(waits);
      expect(refreshes).toBe(0);
    });

    it("drops watchers when the refresh fails, instead of leaving them stale", async () => {
      const watcher = fakeSocket();
      const { host, waits } = socketsOver({
        sockets: [watcher],
        refresh: () => Promise.reject(new Error("facet pull failed")),
      });

      host.refreshThenFlush();
      await Promise.all(waits);

      expect(watcher.sent).toEqual([]);
      expect(watcher.closed).toEqual([{ code: 1011, reason: "refresh failed" }]);
    });
  });
});

// ---------------------------------------------------------------------------
// Keyed lanes: the dial URL and the hibernation tag round-trip the lane key.
// ---------------------------------------------------------------------------

describe("keyed lanes", () => {
  it("round-trips the lane key through the dial URL, including separator characters", async () => {
    for (const lane of ["repo", "capability-host", "weird/lane name"]) {
      let dialed: Request | undefined;
      await dialLiveStateSocket(
        {
          fetch: (input: string, init?: RequestInit) => {
            dialed = new Request(input, init);
            return Promise.resolve({ status: 400 });
          },
        },
        { lane },
      );
      expect(liveStateSocketLaneKey(dialed!)).toBe(lane);
      expect(dialed!.headers.get(LIVE_STATE_SOCKET_HEADER)).not.toBeNull();
    }
  });

  it("reports no lane for the unkeyed dial, so it reaches the host's own lane", async () => {
    let dialed: Request | undefined;
    await dialLiveStateSocket({
      fetch: (input: string, init?: RequestInit) => {
        dialed = new Request(input, init);
        return Promise.resolve({ status: 400 });
      },
    });
    expect(liveStateSocketLaneKey(dialed!)).toBeUndefined();
  });

  it("round-trips the lane key through the hibernation tag and rejects foreign tags", () => {
    expect(parseLiveStateSocketLaneTag(liveStateSocketLaneTag("repo"))).toBe("repo");
    expect(parseLiveStateSocketLaneTag("live-state")).toBeUndefined();
    expect(parseLiveStateSocketLaneTag("wake")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The worker relay, against a fake dialed socket.
// ---------------------------------------------------------------------------

type FakeRelaySocket = WebSocket & {
  emitFrame(state: unknown): void;
  emitClose(): void;
  closed: { code?: number; reason?: string }[];
  accepted: boolean;
};

function fakeRelaySocket(): FakeRelaySocket {
  const listeners: Record<string, ((event: { data?: unknown }) => void)[]> = {};
  const socket = {
    accepted: false,
    closed: [] as { code?: number; reason?: string }[],
    accept() {
      socket.accepted = true;
    },
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      (listeners[type] ??= []).push(listener);
    },
    close(code?: number, reason?: string) {
      socket.closed.push({ code, reason });
    },
    emitFrame(state: unknown) {
      const data = JSON.stringify({ type: "state", state });
      for (const listener of listeners.message ?? []) listener({ data });
    },
    emitClose() {
      for (const listener of listeners.close ?? []) listener({});
    },
  } as unknown as FakeRelaySocket;
  return socket;
}

function collectUpdates() {
  const updates: LiveUpdate<{ n: number }>[] = [];
  return { updates, sink: (update: LiveUpdate<{ n: number }>) => void updates.push(update) };
}

describe("openRelayedLiveState", () => {
  it("get() is a transient read that never dials", async () => {
    let dials = 0;
    const relay = openRelayedLiveState<{ n: number }>({
      dialSocket: async () => {
        dials += 1;
        return { status: 101, webSocket: fakeRelaySocket() };
      },
      readSnapshot: async () => ({ n: 7 }),
      socketFailureDegrade: "reject",
      label: "test",
    });
    expect(await relay.get()).toEqual({ n: 7 });
    expect(dials).toBe(0);
  });

  it("subscribe seeds from the first frame and pushes later frames", async () => {
    const socket = fakeRelaySocket();
    const relay = openRelayedLiveState<{ n: number }>({
      dialSocket: async () => ({ status: 101, webSocket: socket }),
      readSnapshot: async () => {
        throw new Error("must not read a snapshot on the socket path");
      },
      socketFailureDegrade: "reject",
      label: "test",
    });

    const { updates, sink } = collectUpdates();
    const pending = relay.subscribe(sink);
    await Promise.resolve(); // let the dial adopt the socket and attach listeners
    socket.emitFrame({ n: 1 });
    const subscription = await pending;

    expect(socket.accepted).toBe(true);
    expect(updates).toEqual([{ type: "snapshot", revision: 0, state: { n: 1 } }]);
    expect(subscription.ping()).toBe(true);

    vi.useFakeTimers();
    try {
      socket.emitFrame({ n: 2 });
      vi.runAllTimers(); // the engine debounces patches
    } finally {
      vi.useRealTimers();
    }
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ type: "patch" });
  });

  it("shares one dial across concurrent subscribes", async () => {
    let dials = 0;
    const socket = fakeRelaySocket();
    const relay = openRelayedLiveState<{ n: number }>({
      dialSocket: async () => {
        dials += 1;
        return { status: 101, webSocket: socket };
      },
      readSnapshot: async () => ({ n: 0 }),
      socketFailureDegrade: "reject",
      label: "test",
    });
    const a = relay.subscribe(collectUpdates().sink);
    const b = relay.subscribe(collectUpdates().sink);
    await Promise.resolve();
    socket.emitFrame({ n: 1 });
    await Promise.all([a, b]);
    expect(dials).toBe(1);
  });

  it("closes the socket when the last subscriber leaves and re-dials on the next subscribe", async () => {
    const sockets = [fakeRelaySocket(), fakeRelaySocket()];
    let dials = 0;
    const relay = openRelayedLiveState<{ n: number }>({
      dialSocket: async () => ({ status: 101, webSocket: sockets[dials++]! }),
      readSnapshot: async () => ({ n: 0 }),
      socketFailureDegrade: "reject",
      label: "test",
    });

    const pending = relay.subscribe(collectUpdates().sink);
    await Promise.resolve();
    sockets[0]!.emitFrame({ n: 1 });
    const subscription = await pending;
    subscription.unsubscribe();
    expect(sockets[0]!.closed).toEqual([{ code: 1000, reason: "no subscribers" }]);
    sockets[0]!.emitClose();

    const again = relay.subscribe(collectUpdates().sink);
    await Promise.resolve();
    sockets[1]!.emitFrame({ n: 2 });
    await again;
    expect(dials).toBe(2);
  });

  it("fails pings once the socket dies, so the client watchdog re-subscribes", async () => {
    const socket = fakeRelaySocket();
    const relay = openRelayedLiveState<{ n: number }>({
      dialSocket: async () => ({ status: 101, webSocket: socket }),
      readSnapshot: async () => ({ n: 0 }),
      socketFailureDegrade: "reject",
      label: "test",
    });
    const pending = relay.subscribe(collectUpdates().sink);
    await Promise.resolve();
    socket.emitFrame({ n: 1 });
    const subscription = await pending;
    expect(subscription.ping()).toBe(true);
    socket.emitClose();
    expect(subscription.ping()).toBe(false);
  });

  it("rejects on dial failure in reject mode", async () => {
    const relay = openRelayedLiveState<{ n: number }>({
      dialSocket: async () => ({ status: 400, webSocket: null }),
      readSnapshot: async () => ({ n: 0 }),
      socketFailureDegrade: "reject",
      label: "test",
    });
    await expect(relay.subscribe(collectUpdates().sink)).rejects.toThrow(
      "liveState socket upgrade refused with status 400",
    );
    // A later subscribe retries the dial instead of memoizing the rejection.
    await expect(relay.subscribe(collectUpdates().sink)).rejects.toThrow("400");
  });

  it("degrades to a snapshot-only subscription in snapshot-only mode", async () => {
    const relay = openRelayedLiveState<{ n: number }>({
      dialSocket: async () => ({ status: 400, webSocket: null }),
      readSnapshot: async () => ({ n: 5 }),
      socketFailureDegrade: "snapshot-only",
      label: "test",
    });
    const { updates, sink } = collectUpdates();
    const subscription = await relay.subscribe(sink);
    expect(updates).toEqual([{ type: "snapshot", revision: 0, state: { n: 5 } }]);
    // A degraded subscription is frozen at its first paint, so it must report
    // unhealthy — the owner's watchdog is the only way back to live data, and
    // a healthy-looking frozen subscription is a silently stale page forever.
    expect(subscription.ping()).toBe(false);
  });

  it("ignores late frames from a socket released by the last unsubscribe", async () => {
    const sockets = [fakeRelaySocket(), fakeRelaySocket()];
    let dials = 0;
    const relay = openRelayedLiveState<{ n: number }>({
      dialSocket: async () => ({ status: 101, webSocket: sockets[dials++]! }),
      readSnapshot: async () => ({ n: 0 }),
      socketFailureDegrade: "reject",
      label: "test",
    });

    const first = relay.subscribe(collectUpdates().sink);
    await Promise.resolve();
    sockets[0]!.emitFrame({ n: 1 });
    (await first).unsubscribe();
    // The release called close(), but no close EVENT has fired yet — an
    // already-queued frame can still deliver. A fast resubscribe dials a
    // fresh socket and seeds newer state; the released socket's late frame
    // must not rewind it.
    const { updates, sink } = collectUpdates();
    const second = relay.subscribe(sink);
    await Promise.resolve();
    sockets[1]!.emitFrame({ n: 3 });
    await second;
    sockets[0]!.emitFrame({ n: 2 });
    expect(updates).toEqual([{ type: "snapshot", revision: 0, state: { n: 3 } }]);
    vi.useFakeTimers();
    try {
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    expect(updates).toHaveLength(1);
  });

  it("times out the seed wait, closes the socket, and ignores its late frames", async () => {
    vi.useFakeTimers();
    try {
      const slow = fakeRelaySocket();
      const good = fakeRelaySocket();
      let dials = 0;
      const relay = openRelayedLiveState<{ n: number }>({
        dialSocket: async () => ({ status: 101, webSocket: dials++ === 0 ? slow : good }),
        readSnapshot: async () => ({ n: 0 }),
        socketFailureDegrade: "reject",
        label: "test",
      });

      const first = relay.subscribe(collectUpdates().sink);
      first.catch(() => undefined); // asserted below; never unhandled
      await Promise.resolve();
      vi.runAllTimers(); // seed-frame timeout fires
      await expect(first).rejects.toThrow("seed frame timed out");
      expect(slow.closed).toEqual([{ code: 1000, reason: "seed frame timed out" }]);

      const { updates, sink } = collectUpdates();
      const second = relay.subscribe(sink);
      await Promise.resolve();
      good.emitFrame({ n: 2 });
      await second;
      // The abandoned socket's late frame must not rewind the engine.
      slow.emitFrame({ n: 1 });
      expect(updates).toEqual([{ type: "snapshot", revision: 0, state: { n: 2 } }]);
      vi.runAllTimers();
      expect(updates).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
