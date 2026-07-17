import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { waitForStreamIdempotencyKey } from "./wait-for-idempotency-key.ts";

class TestSocket extends EventTarget {
  readonly close = vi.fn();

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  disconnect(code = 1012, reason = "incarnation restarted"): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

function event(idempotencyKey = "settled:exec-1"): StreamEvent {
  return {
    createdAt: "2026-07-17T00:00:00.000Z",
    idempotencyKey,
    offset: 42,
    path: "/agents/test",
    payload: { executionId: "exec-1" },
    type: "events.iterate.com/capability-host/script-run-settled",
  };
}

function asWebSocket(socket: TestSocket): WebSocket {
  return socket as unknown as WebSocket;
}

describe("waitForStreamIdempotencyKey", () => {
  it("returns the exact event delivered over one socket", async () => {
    const socket = new TestSocket();
    const connect = vi.fn(async () => asWebSocket(socket));
    const waiting = waitForStreamIdempotencyKey({
      connect,
      idempotencyKey: "settled:exec-1",
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    socket.message(event());

    await expect(waiting).resolves.toEqual(event());
    expect(connect).toHaveBeenCalledWith("settled:exec-1");
  });

  it("reconnects after a lifecycle close and accepts replay from the new incarnation", async () => {
    const first = new TestSocket();
    const second = new TestSocket();
    const connect = vi
      .fn<() => Promise<WebSocket>>()
      .mockResolvedValueOnce(asWebSocket(first))
      .mockResolvedValueOnce(asWebSocket(second));
    const waiting = waitForStreamIdempotencyKey({
      connect,
      idempotencyKey: "settled:exec-1",
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    first.disconnect();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    second.message(event());

    await expect(waiting).resolves.toMatchObject({ offset: 42 });
  });

  it("bounds a disconnect storm and classifies it as stream unavailable", async () => {
    const sockets = Array.from({ length: 4 }, () => new TestSocket());
    const connect = vi.fn(async () => asWebSocket(sockets[connect.mock.calls.length - 1]!));
    const waiting = waitForStreamIdempotencyKey({
      connect,
      idempotencyKey: "settled:exec-1",
      timeoutMs: 1_000,
    });
    for (let count = 1; count <= sockets.length; count += 1) {
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(count));
      sockets[count - 1]!.disconnect();
    }

    await expect(waiting).rejects.toThrow(
      "stream-unavailable: idempotency wait disconnected 4 consecutive times",
    );
  });

  it("rejects a wrong-key frame as a protocol defect without reconnecting", async () => {
    const socket = new TestSocket();
    const connect = vi.fn(async () => asWebSocket(socket));
    const waiting = waitForStreamIdempotencyKey({
      connect,
      idempotencyKey: "settled:exec-1",
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    socket.message(event("settled:other"));

    await expect(waiting).rejects.toThrow('received key "settled:other"');
    expect(connect).toHaveBeenCalledOnce();
  });

  it("enforces one absolute timeout", async () => {
    const socket = new TestSocket();
    const waiting = waitForStreamIdempotencyKey({
      connect: async () => asWebSocket(socket),
      idempotencyKey: "settled:exec-1",
      timeoutMs: 10,
    });

    await expect(waiting).rejects.toThrow(
      'Timed out waiting 10ms for stream event with idempotency key "settled:exec-1".',
    );
    expect(socket.close).toHaveBeenCalledWith(1000, "absolute wait deadline reached");
  });
});
