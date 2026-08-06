import { describe, expect, it, vi } from "vitest";
import type { CapabilityRecord } from "./types.ts";
import {
  LIVE_CAPABILITY_RETIRED_CLOSE_CODE,
  LiveCapabilityLeaseServer,
} from "./live-capability-lease.ts";

type FakeSocket = WebSocket & {
  attachment: unknown;
  closed: { code?: number; reason?: string }[];
  sent: string[];
};

function fakeSocket(socketId = "socket-1"): FakeSocket {
  const socket = {
    attachment: { socketId },
    closed: [] as { code?: number; reason?: string }[],
    sent: [] as string[],
    get readyState() {
      return socket.closed.length === 0 ? 1 : 2;
    },
    close(code?: number, reason?: string) {
      socket.closed.push({ code, reason });
    },
    deserializeAttachment() {
      return socket.attachment;
    },
    send(data: string) {
      socket.sent.push(data);
    },
    serializeAttachment(value: unknown) {
      socket.attachment = value;
    },
  } as unknown as FakeSocket;
  return socket;
}

function leaseOver(sockets: FakeSocket[]) {
  return new LiveCapabilityLeaseServer({
    acceptWebSocket: () => undefined,
    getWebSockets: () => sockets.filter((socket) => socket.closed.length === 0),
  });
}

const record: Extract<CapabilityRecord, { type: "live" }> = {
  path: ["tools"],
  providerBinding: { socketId: "socket-1" },
  providedAtOffset: 7,
  type: "live",
};

function provider(result: (value: string) => unknown) {
  const retainedDispose = vi.fn();
  const echo = vi.fn(result);
  const invoke = vi.fn((_path: string[], args: unknown[]) => echo(args[0] as string));
  class FakeInvokerStub {
    dup = vi.fn(() => ({
      [Symbol.dispose]: retainedDispose,
      invoke,
    }));
  }
  const stub = new FakeInvokerStub();
  return { echo, retainedDispose, stub };
}

function activate(
  lease: LiveCapabilityLeaseServer,
  liveProvider: ReturnType<typeof provider>,
  capabilityRecord = record,
) {
  return lease.activate(
    {
      invoker: liveProvider.stub,
      path: capabilityRecord.path,
      providedAtOffset: capabilityRecord.providedAtOffset,
      socketId: capabilityRecord.providerBinding.socketId,
    },
    capabilityRecord,
  );
}

describe("LiveCapabilityLeaseServer", () => {
  it("retains no provider until demand and shares one short leg across a concurrent burst", async () => {
    const socket = fakeSocket();
    const lease = leaseOver([socket]);
    expect(lease.bindProvision(record, "socket-1")).toBe(true);

    const first = lease.invoke(record, ["echo"], ["one"]);
    const second = lease.invoke(record, ["echo"], ["two"]);
    expect(socket.sent).toEqual(['{"type":"wake"}']);

    const liveProvider = provider((value) => `received ${value}`);
    expect(activate(lease, liveProvider)).not.toBeUndefined();
    await expect(Promise.all([first, second])).resolves.toEqual(["received one", "received two"]);
    expect(liveProvider.stub.dup).toHaveBeenCalledOnce();
    expect(liveProvider.echo).toHaveBeenCalledTimes(2);
    expect(liveProvider.retainedDispose).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual(['{"type":"wake"}', '{"type":"idle"}']);
  });

  it("reconstructs the lease from only the socket attachment after hibernation", async () => {
    const socket = fakeSocket();
    const firstIncarnation = leaseOver([socket]);
    firstIncarnation.bindProvision(record, "socket-1");

    const reconstructed = leaseOver([socket]);
    const invocation = reconstructed.invoke(record, ["echo"], ["after hibernation"]);
    const liveProvider = provider((value) => value);
    expect(activate(reconstructed, liveProvider)).not.toBeUndefined();

    await expect(invocation).resolves.toBe("after hibernation");
    expect(socket.sent).toEqual(['{"type":"wake"}', '{"type":"idle"}']);
  });

  it("rejects unsolicited or wrong-socket provider legs", async () => {
    const socket = fakeSocket();
    const lease = leaseOver([socket]);
    lease.bindProvision(record, "socket-1");
    const liveProvider = provider((value) => value);

    expect(activate(lease, liveProvider)).toBeUndefined();
    expect(liveProvider.stub.dup).not.toHaveBeenCalled();

    const invocation = lease.invoke(record, ["echo"], ["never"]);
    expect(
      lease.activate(
        {
          invoker: liveProvider.stub,
          path: record.path,
          providedAtOffset: record.providedAtOffset,
          socketId: "wrong-socket",
        },
        record,
      ),
    ).toBeUndefined();
    lease.remove(record, { notifyRelay: false });
    await expect(invocation).rejects.toThrow('capability "tools" is offline');
  });

  it("binds only the record's exact one-socket lease", () => {
    const expected = fakeSocket();
    const wrong = fakeSocket("socket-2");
    const lease = leaseOver([expected, wrong]);

    expect(lease.bindProvision(record, "socket-2")).toBe(false);
    expect(lease.bindProvision(record, "socket-1")).toBe(true);
    expect(lease.hasLease(record)).toBe(true);
    expect(lease.hasLease({ ...record, providerBinding: { socketId: "missing" } })).toBe(false);
  });

  it("closes the exact socket when its durable mount retires", () => {
    const socket = fakeSocket();
    const lease = leaseOver([socket]);
    lease.bindProvision(record, "socket-1");

    lease.remove(record);

    expect(socket.closed).toEqual([
      { code: LIVE_CAPABILITY_RETIRED_CLOSE_CODE, reason: "live capability retired" },
    ]);
    expect(lease.hasLease(record)).toBe(false);
  });

  it("times out a missing attach and can wake the healthy lease again", async () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      const lease = leaseOver([socket]);
      lease.bindProvision(record, "socket-1");

      const timedOut = lease.invoke(record, ["echo"], ["first"]);
      const rejection = expect(timedOut).rejects.toThrow("provider did not attach within 10000ms");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;

      const recovered = lease.invoke(record, ["echo"], ["second"]);
      const liveProvider = provider((value) => value);
      expect(activate(lease, liveProvider)).not.toBeUndefined();
      await expect(recovered).resolves.toBe("second");
      expect(socket.sent).toEqual(['{"type":"wake"}', '{"type":"wake"}', '{"type":"idle"}']);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails an invalid provider attach without leaving the invocation pending", async () => {
    const socket = fakeSocket();
    const lease = leaseOver([socket]);
    lease.bindProvision(record, "socket-1");
    const invocation = lease.invoke(record, ["value"], []);

    expect(() =>
      lease.activate(
        {
          invoker: {},
          path: record.path,
          providedAtOffset: record.providedAtOffset,
          socketId: "socket-1",
        },
        record,
      ),
    ).toThrow("attach requires an invoker RPC target");
    await expect(invocation).rejects.toThrow("attach requires an invoker RPC target");
  });
});
