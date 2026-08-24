// The connection relay against a fake Stream Durable Object: what happens to a
// session connection when the incarnation behind it disappears.
//
// The distinction the relay has to get right is hibernation vs RESET.
// Hibernation keeps the client-given Pager socket, so the relay only has to
// wait for the next Page. A reset closes every hibernatable socket, so the
// relay loses BOTH its RPC leg and its return address at once — and it is the
// only party that can notice: the caller is holding an already-resolved
// `StreamConnectionHandle`, and the Durable Object that would have appended a
// `connection-closed` fact is the thing that just died.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamEventBatch } from "iterate/processors";
import type { Stream } from "../../itx-api.generated.ts";
import { openRelayedStreamConnection } from "./stream-connection-relay.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";

afterEach(() => vi.restoreAllMocks());

/** Let every queued microtask and the relay's async recovery run to completion. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};

type FakePagerSocket = {
  closedWith: { code?: number; reason?: string }[];
  /** Deliver one Page frame to the relay, as the Durable Object would. */
  page(frame: unknown): void;
  /** The incarnation that accepted this socket ended; workerd closes it. */
  die(): void;
};

function fakePagerSocket(): FakePagerSocket & WebSocket {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  let gone = false;
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const socket = {
    closedWith: [] as { code?: number; reason?: string }[],
    accept() {},
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    // A local close does not fire the local close listener, exactly like the
    // real socket: only the peer's disappearance does.
    close(code?: number, reason?: string) {
      gone = true;
      socket.closedWith.push({ code, reason });
    },
    page(frame: unknown) {
      if (gone) return;
      emit("message", { data: JSON.stringify(frame) });
    },
    die() {
      if (gone) return;
      gone = true;
      emit("close", {});
    },
  };
  return socket as unknown as FakePagerSocket & WebSocket;
}

/**
 * One Stream Durable Object's worth of behaviour: an incarnation counter, Pager
 * sockets that belong to the incarnation that accepted them, and one session
 * connection whose callback lives only as long as that incarnation.
 */
function fakeStreamDurableObject(options: { refusePagerAfterReset?: boolean } = {}) {
  const openArgs: { replayAfterOffset?: number; pagerId?: string }[] = [];
  let incarnation = 0;
  let maxOffset = 10;
  let sockets: (FakePagerSocket & WebSocket)[] = [];
  let connection: { born: number; deliver: (batch: StreamEventBatch) => void } | undefined;

  const batchOf = (events: StreamEvent[], scannedAfterOffset: number): StreamEventBatch => ({
    projectId: "prj_fake",
    path: "/fake",
    streamId: "11111111-1111-4111-8111-111111111111",
    events,
    scannedAfterOffset,
    scannedThroughOffset: maxOffset,
    streamMaxOffset: maxOffset,
    state: null,
  });

  const stub = {
    fetch: (_url: string, _init?: RequestInit) => {
      if (options.refusePagerAfterReset === true && incarnation > 0) {
        return Promise.resolve({ status: 500, webSocket: null } as unknown as Response);
      }
      const socket = fakePagerSocket();
      sockets.push(socket);
      return Promise.resolve({ status: 101, webSocket: socket } as unknown as Response);
    },
    openConnection: (
      args: Parameters<Stream["openConnection"]>[0],
      relay?: { subscriberPagerId: string },
    ) => {
      const born = incarnation;
      openArgs.push({
        ...(args.replayAfterOffset === undefined
          ? {}
          : { replayAfterOffset: args.replayAfterOffset }),
        ...(relay === undefined ? {} : { pagerId: relay.subscriberPagerId }),
      });
      connection = { born, deliver: (batch) => args.processEventBatch(batch) };
      // Every session connection receives one batch on open, so its callback
      // can paint without a separate read (StreamConnections.#open).
      args.processEventBatch(batchOf([], maxOffset));
      const handle = {
        streamMaxOffset: maxOffset,
        ping: () =>
          born === incarnation
            ? Promise.resolve(true)
            : Promise.reject(
                Object.assign(new Error("Durable Object reset."), { durableObjectReset: true }),
              ),
        close: () => Promise.resolve(),
        [Symbol.dispose]: () => {},
      };
      return Promise.resolve(handle);
    },
  };

  return {
    stub: () => stub as unknown as DurableObjectStub<StreamDurableObject>,
    openArgs,
    /** Commit one event; deliver it live, or Page the dormant subscriber. */
    append(type: string) {
      maxOffset += 1;
      const event = {
        offset: maxOffset,
        type,
        createdAt: "2026-08-09T00:00:00.000Z",
        path: "/fake",
      } as StreamEvent;
      if (connection !== undefined && connection.born === incarnation) {
        connection.deliver(batchOf([event], maxOffset - 1));
        return;
      }
      for (const socket of sockets) socket.page({ type: "page" });
    },
    /** The incarnation is aborted: its sockets and its connection table go with it. */
    reset() {
      incarnation += 1;
      connection = undefined;
      const dying = sockets;
      sockets = [];
      for (const socket of dying) socket.die();
    },
    /** Only the Pager sockets go (a bind-time attachment degrade closes them). */
    dropPagers() {
      const dying = sockets;
      sockets = [];
      for (const socket of dying) socket.die();
    },
  };
}

function relayArgs(
  connectionKey: string,
  onBatch: (batch: StreamEventBatch) => void,
): Parameters<Stream["openConnection"]>[0] {
  return { connectionKey, processEventBatch: onBatch };
}

describe("openRelayedStreamConnection", () => {
  it("resumes the subscription when a Durable Object reset kills the Pager and the leg", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const durableObject = fakeStreamDurableObject();
    const seen: string[] = [];
    const relay = await openRelayedStreamConnection({
      stub: durableObject.stub,
      args: relayArgs("probe", (batch) => {
        for (const event of batch.events) seen.push(event.type);
      }),
    });

    durableObject.append("example.com/before");
    expect(seen).toEqual(["example.com/before"]);

    // The reset is invisible to the caller: its handle stays resolved and no
    // close fact can be appended, because the appender is what died.
    durableObject.reset();
    await settle();

    durableObject.append("example.com/after");
    await settle();

    expect(seen).toEqual(["example.com/before", "example.com/after"]);
    await expect(relay.isLive()).resolves.toBe(true);
    // The resume re-opened from the exact delivered cursor under the same Pager
    // id, so nothing between the two events could be skipped or replayed twice.
    expect(durableObject.openArgs).toEqual([
      { pagerId: expect.any(String) },
      { replayAfterOffset: 11, pagerId: expect.any(String) },
    ]);
    expect(durableObject.openArgs[0]?.pagerId).toBe(durableObject.openArgs[1]?.pagerId);
  });

  it("keeps a live RPC leg pinned instead of re-opening it when only the Pager dies", async () => {
    const durableObject = fakeStreamDurableObject();
    const relay = await openRelayedStreamConnection({
      stub: durableObject.stub,
      args: relayArgs("probe", () => undefined),
    });

    // A Pager lost while the leg still answers costs only idle eligibility.
    // Re-opening here would replay a batch and churn lifecycle facts for
    // nothing — and would re-close the socket forever when the loss came from
    // the bind-time oversized-attachment degrade.
    durableObject.dropPagers();
    await settle();
    await expect(relay.isLive()).resolves.toBe(true);
    expect(durableObject.openArgs).toHaveLength(1);
  });

  it("closes the relay when the Pager cannot be re-attached after a reset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const durableObject = fakeStreamDurableObject({ refusePagerAfterReset: true });
    const relay = await openRelayedStreamConnection({
      stub: durableObject.stub,
      args: relayArgs("probe", () => undefined),
    });

    durableObject.reset();
    await settle();

    expect(await relay.isLive()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "stream connection relay closed",
      expect.objectContaining({
        connectionKey: "probe",
        reason: "Subscriber Pager closed and could not be resumed",
      }),
    );
  });
});
