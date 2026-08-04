// The liveState-socket lane against fake sockets: the token gate, the
// read-at-flush-time flusher, the skipped-assembly reload, and the worker
// relay's seed/degrade/release races — unit-tested without a Durable Object.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdate } from "iterate/sdk/capnweb";
import {
  LiveStateSockets,
  openRelayedLiveState,
  parseLiveStateSocketFrame,
  LIVE_STATE_SOCKET_HEADER,
} from "./live-state-socket.ts";

const LANE_TOKEN = "test-lane-token";

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
    laneToken: () => Promise.resolve(LANE_TOKEN),
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

  it("rejects a wrong token with 403 and never falls through", async () => {
    const { host } = socketsOver({ sockets: [] });
    const response = await host.acceptUpgrade(
      new Request("https://x.internal/", {
        headers: { Upgrade: "websocket", [LIVE_STATE_SOCKET_HEADER]: "wrong" },
      }),
    );
    expect(response?.status).toBe(403);
  });

  it("rejects a valid token without a WebSocket upgrade", async () => {
    const { host } = socketsOver({ sockets: [] });
    const response = await host.acceptUpgrade(
      new Request("https://x.internal/", {
        headers: { [LIVE_STATE_SOCKET_HEADER]: LANE_TOKEN },
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
    // ping stays true: a false ping would re-dial in a loop against a host
    // that already said no.
    expect(subscription.ping()).toBe(true);
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
