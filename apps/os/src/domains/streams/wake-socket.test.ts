// WakeSocketRegistry against fake sockets: the wake-matching predicate,
// dormancy stamping, same-key supersede, and departure detection — the
// subtlest wake-socket logic, unit-tested without a Durable Object.

import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { WakeSocketRegistry } from "./wake-socket.ts";

type FakeSocket = WebSocket & {
  attachment: unknown;
  sent: string[];
  closed: { code?: number; reason?: string }[];
};

function fakeSocket(attachment: unknown): FakeSocket {
  const socket = {
    attachment,
    sent: [] as string[],
    closed: [] as { code?: number; reason?: string }[],
    serializeAttachment(value: unknown) {
      socket.attachment = value;
    },
    deserializeAttachment() {
      return socket.attachment;
    },
    send(data: string) {
      socket.sent.push(data);
    },
    close(code?: number, reason?: string) {
      socket.closed.push({ code, reason });
    },
  } as unknown as FakeSocket;
  return socket;
}

function registryOver(sockets: FakeSocket[], liveKeys: string[] = []) {
  return new WakeSocketRegistry({
    getWebSockets: () => sockets.filter((socket) => socket.closed.length === 0),
    acceptWebSocket: () => undefined,
    maxOffset: () => 100,
    hasConnection: (connectionKey) => liveKeys.includes(connectionKey),
  });
}

function event(offset: number, type = "example.com/tick", ephemeral?: boolean): StreamEvent {
  return {
    offset,
    type,
    createdAt: "2026-08-03T12:00:00.000Z",
    path: "/t",
    ...(ephemeral === undefined ? {} : { ephemeral }),
  } as StreamEvent;
}

const dormant = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  connectionKey: "sub",
  socketId: "sock-1",
  idleDeliveredThrough: 10,
  ...overrides,
});

describe("WakeSocketRegistry", () => {
  it("wakes a dormant subscriber once per dormancy period, offset-gated", () => {
    const socket = fakeSocket(dormant());
    const registry = registryOver([socket]);

    registry.wakeDormant([event(10)]);
    expect(socket.sent).toEqual([]); // at or below the stamped cursor

    registry.wakeDormant([event(11)]);
    expect(socket.sent).toEqual(['{"type":"wake"}']);

    registry.wakeDormant([event(12)]);
    expect(socket.sent).toHaveLength(1); // wakeSentAtOffset dedupes until re-bind
  });

  it("never wakes on lifecycle facts or ephemeral rows unless the filter names them", () => {
    const plain = fakeSocket(dormant());
    const lifecycleNamed = fakeSocket(
      dormant({
        socketId: "sock-2",
        connectionKey: "presence",
        filter: { eventTypes: ["events.iterate.com/stream/connection-closed"] },
      }),
    );
    const registry = registryOver([plain, lifecycleNamed]);

    registry.wakeDormant([event(11, "events.iterate.com/stream/woken")]);
    registry.wakeDormant([event(12, "example.com/tick", true)]);
    expect(plain.sent).toEqual([]);
    expect(lifecycleNamed.sent).toEqual([]);

    registry.wakeDormant([event(13, "events.iterate.com/stream/connection-closed")]);
    expect(plain.sent).toEqual([]); // lifecycle-excluded for unfiltered subscribers
    expect(lifecycleNamed.sent).toEqual(['{"type":"wake"}']); // explicit naming opts in
  });

  it("treats an unstamped, connection-absent socket as eviction recovery", () => {
    const socket = fakeSocket(dormant({ idleDeliveredThrough: undefined }));
    const registry = registryOver([socket]);
    registry.wakeDormant([event(1)]);
    expect(socket.sent).toEqual(['{"type":"wake"}']);
  });

  it("never wakes a socket whose connection is live", () => {
    const socket = fakeSocket(dormant());
    const registry = registryOver([socket], ["sub"]);
    registry.wakeDormant([event(99)]);
    expect(socket.sent).toEqual([]);
  });

  it("bind keeps its own socket, supersedes same-key strays, and clears dormancy", () => {
    const mine = fakeSocket(dormant({ wakeSentAtOffset: 9 }));
    const stray = fakeSocket(dormant({ socketId: "sock-stale" }));
    const registry = registryOver([mine, stray]);

    registry.bind({ connectionKey: "sub", wakeSocketId: "sock-1", filter: {} });

    expect(stray.closed).toEqual([{ code: 1000, reason: "superseded" }]);
    expect(mine.closed).toEqual([]);
    const attachment = mine.attachment as Record<string, unknown>;
    expect(attachment.idleDeliveredThrough).toBeUndefined();
    expect(attachment.wakeSentAtOffset).toBeUndefined();
  });

  it("recordIdleClosed stamps the current head and sends one idle frame", () => {
    const socket = fakeSocket(dormant({ idleDeliveredThrough: undefined }));
    const registry = registryOver([socket]);

    registry.recordIdleClosed(["sub"]);

    expect((socket.attachment as Record<string, unknown>).idleDeliveredThrough).toBe(100);
    expect(socket.sent).toEqual(['{"type":"idle"}']);
  });

  it("reports a departure only for dormant subscribers without a live replacement", () => {
    const registry = registryOver([]);
    expect(registry.departedOnClose(fakeSocket(dormant()))).toEqual({
      connectionKey: "sub",
      socketId: "sock-1",
    });
    // Live connection: its own close path owns the fact.
    expect(registryOver([], ["sub"]).departedOnClose(fakeSocket(dormant()))).toBeUndefined();
    // Never idled: no dormancy, no departure fact owed.
    expect(
      registry.departedOnClose(fakeSocket(dormant({ idleDeliveredThrough: undefined }))),
    ).toBeUndefined();
  });
});
