import { describe, expect, it, vi } from "vitest";
import type { CapabilityRecord } from "./types.ts";
import { LiveCapabilityLeaseServer } from "./live-capability-lease.ts";

type LiveCapabilityRecord = Extract<CapabilityRecord, { type: "live" }>;

type FakeSocket = WebSocket & {
  attachment: unknown;
  closed: { code?: number; reason?: string }[];
  sent: string[];
};

function fakeSocket(attachment: unknown): FakeSocket {
  const socket = {
    attachment,
    closed: [] as { code?: number; reason?: string }[],
    sent: [] as string[],
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

function unboundSocket(channelKey = "channel-1", socketId = "socket-1") {
  return fakeSocket({ channelKey, socketId, v: 2 });
}

const record: LiveCapabilityRecord = {
  path: ["tools"],
  providerBinding: { channelKey: "channel-1", leaseKey: "lease-1", socketId: "socket-1" },
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
  return { echo, invoke, retainedDispose, stub };
}

describe("LiveCapabilityLeaseServer", () => {
  it("retains no provider until demand and shares one attach across a concurrent burst", async () => {
    const socket = unboundSocket();
    const lease = leaseOver([socket]);
    expect(lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" })).toBe(true);
    expect(socket.sent).toEqual([]);

    const firstInvocation = lease.invoke(record, ["echo"], ["one"]);
    const secondInvocation = lease.invoke(record, ["echo"], ["two"]);
    expect(socket.sent).toEqual(['{"type":"wake","leaseKey":"lease-1"}']);

    const liveProvider = provider((value) => `received ${value}`);
    expect(
      lease.activate(
        {
          invoker: liveProvider.stub,
          channelKey: "channel-1",
          leaseKey: "lease-1",
          path: record.path,
          providedAtOffset: record.providedAtOffset,
          socketId: "socket-1",
        },
        record,
      ),
    ).not.toBeUndefined();

    await expect(Promise.all([firstInvocation, secondInvocation])).resolves.toEqual([
      "received one",
      "received two",
    ]);
    expect(liveProvider.stub.dup).toHaveBeenCalledOnce();
    expect(liveProvider.echo).toHaveBeenCalledTimes(2);
    expect(liveProvider.retainedDispose).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([
      '{"type":"wake","leaseKey":"lease-1"}',
      '{"type":"idle","leaseKey":"lease-1"}',
    ]);
  });

  it("reconstructs a fresh short RPC leg after every idle period", async () => {
    const socket = unboundSocket();
    const lease = leaseOver([socket]);
    lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });

    const firstInvocation = lease.invoke(record, ["echo"], ["first"]);
    const firstProvider = provider((value) => value);
    lease.activate(
      {
        invoker: firstProvider.stub,
        channelKey: "channel-1",
        leaseKey: "lease-1",
        path: record.path,
        providedAtOffset: record.providedAtOffset,
        socketId: "socket-1",
      },
      record,
    );
    await expect(firstInvocation).resolves.toBe("first");

    const secondInvocation = lease.invoke(record, ["echo"], ["second"]);
    const secondProvider = provider((value) => value);
    lease.activate(
      {
        invoker: secondProvider.stub,
        channelKey: "channel-1",
        leaseKey: "lease-1",
        path: record.path,
        providedAtOffset: record.providedAtOffset,
        socketId: "socket-1",
      },
      record,
    );
    await expect(secondInvocation).resolves.toBe("second");

    expect(firstProvider.stub.dup).toHaveBeenCalledOnce();
    expect(firstProvider.retainedDispose).toHaveBeenCalledOnce();
    expect(secondProvider.stub.dup).toHaveBeenCalledOnce();
    expect(secondProvider.retainedDispose).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([
      '{"type":"wake","leaseKey":"lease-1"}',
      '{"type":"idle","leaseKey":"lease-1"}',
      '{"type":"wake","leaseKey":"lease-1"}',
      '{"type":"idle","leaseKey":"lease-1"}',
    ]);
  });

  it("reconstructs its lease solely from the socket attachment after DO hibernation", async () => {
    const socket = unboundSocket();
    const firstIncarnation = leaseOver([socket]);
    firstIncarnation.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });

    // Drop every in-memory map with the first server. A newly constructed DO
    // incarnation sees only the runtime-owned socket and its attachment.
    const reconstructed = leaseOver([socket]);
    const invocation = reconstructed.invoke(record, ["echo"], ["after hibernation"]);
    expect(socket.sent).toEqual(['{"type":"wake","leaseKey":"lease-1"}']);

    const liveProvider = provider((value) => value);
    expect(
      reconstructed.activate(
        {
          invoker: liveProvider.stub,
          channelKey: "channel-1",
          leaseKey: "lease-1",
          path: record.path,
          providedAtOffset: record.providedAtOffset,
          socketId: "socket-1",
        },
        record,
      ),
    ).not.toBeUndefined();

    await expect(invocation).resolves.toBe("after hibernation");
    expect(liveProvider.retainedDispose).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([
      '{"type":"wake","leaseKey":"lease-1"}',
      '{"type":"idle","leaseKey":"lease-1"}',
    ]);
  });

  it("keeps one thousand providers dormant and wakes only the selected leases", async () => {
    const records = Array.from(
      { length: 1_000 },
      (_, index): LiveCapabilityRecord => ({
        path: ["provider", String(index)],
        providerBinding: {
          channelKey: "channel-1",
          leaseKey: `lease-${index}`,
          socketId: "socket-1",
        },
        providedAtOffset: index + 1,
        type: "live",
      }),
    );
    const socket = unboundSocket();
    const firstIncarnation = leaseOver([socket]);

    for (const capabilityRecord of records) {
      expect(
        firstIncarnation.bindProvision(capabilityRecord, {
          leaseKey: "channel-1",
          socketId: "socket-1",
        }),
      ).toBe(true);
    }
    expect(socket.sent).toEqual([]);

    const selected = [2, 499, 997];
    const invocations = selected.map((index) =>
      firstIncarnation.invoke(records[index]!, ["value"], [`call-${index}`]),
    );
    const providers = selected.map((index) => provider((value) => `${index}:${value}`));
    for (const [selectedIndex, index] of selected.entries()) {
      expect(
        firstIncarnation.activate(
          {
            invoker: providers[selectedIndex]!.stub,
            channelKey: "channel-1",
            leaseKey: `lease-${index}`,
            path: records[index]!.path,
            providedAtOffset: records[index]!.providedAtOffset,
            socketId: "socket-1",
          },
          records[index]!,
        ),
      ).not.toBeUndefined();
    }

    await expect(Promise.all(invocations)).resolves.toEqual([
      "2:call-2",
      "499:call-499",
      "997:call-997",
    ]);
    expect(socket.sent).toEqual([
      '{"type":"wake","leaseKey":"lease-2"}',
      '{"type":"wake","leaseKey":"lease-499"}',
      '{"type":"wake","leaseKey":"lease-997"}',
      '{"type":"idle","leaseKey":"lease-2"}',
      '{"type":"idle","leaseKey":"lease-499"}',
      '{"type":"idle","leaseKey":"lease-997"}',
    ]);
    for (const liveProvider of providers) {
      expect(liveProvider.stub.dup).toHaveBeenCalledOnce();
      expect(liveProvider.retainedDispose).toHaveBeenCalledOnce();
    }

    // A new server has no in-memory provider state. It sees all one thousand
    // logical leases through one hibernatable channel and durable record
    // addresses, and still wakes only the newly selected record.
    const secondIncarnation = leaseOver([socket]);
    const invocation = secondIncarnation.invoke(records[700]!, ["value"], ["after hibernation"]);
    const reconstructedProvider = provider((value) => `700:${value}`);
    expect(
      secondIncarnation.activate(
        {
          invoker: reconstructedProvider.stub,
          channelKey: "channel-1",
          leaseKey: "lease-700",
          path: records[700]!.path,
          providedAtOffset: records[700]!.providedAtOffset,
          socketId: "socket-1",
        },
        records[700]!,
      ),
    ).not.toBeUndefined();
    await expect(invocation).resolves.toBe("700:after hibernation");
    expect(reconstructedProvider.retainedDispose).toHaveBeenCalledOnce();
    expect(socket.sent.slice(-2)).toEqual([
      '{"type":"wake","leaseKey":"lease-700"}',
      '{"type":"idle","leaseKey":"lease-700"}',
    ]);
  });

  it("rejects unsolicited provider legs and tears down the exact lease on departure", async () => {
    const socket = unboundSocket();
    const lease = leaseOver([socket]);
    lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });
    const liveProvider = provider((value) => value);

    expect(
      lease.activate(
        {
          invoker: liveProvider.stub,
          channelKey: "channel-1",
          leaseKey: "lease-1",
          path: record.path,
          providedAtOffset: record.providedAtOffset,
          socketId: "socket-1",
        },
        record,
      ),
    ).toBeUndefined();
    expect(liveProvider.stub.dup).not.toHaveBeenCalled();

    const invocation = lease.invoke(record, ["echo"], ["never"]);
    expect(lease.departedOnClose(socket)).toEqual({
      channelKey: "channel-1",
      socketId: "socket-1",
    });
    expect(lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" })).toBe(
      false,
    );
    lease.remove(record, { notifyRelay: false });
    await expect(invocation).rejects.toThrow('capability "tools" is offline');
  });

  it("tracks superseded and replacement socket departures as exact epochs", () => {
    const stale = unboundSocket("channel-1", "socket-stale");
    const replacement = unboundSocket("channel-1", "socket-new");
    const lease = leaseOver([stale, replacement]);
    const replacementRecord: LiveCapabilityRecord = {
      ...record,
      providerBinding: {
        channelKey: "channel-1",
        leaseKey: "lease-1",
        socketId: "socket-new",
      },
    };

    expect(lease.departedOnClose(stale)).toEqual({
      channelKey: "channel-1",
      socketId: "socket-stale",
    });
    expect(
      lease.bindProvision(replacementRecord, {
        leaseKey: "channel-1",
        socketId: "socket-new",
      }),
    ).toBe(true);
    expect(lease.hasLease(replacementRecord)).toBe(true);
    expect(lease.departedOnClose(replacement)).toEqual({
      channelKey: "channel-1",
      socketId: "socket-new",
    });
    expect(lease.hasLease(replacementRecord)).toBe(false);
  });

  it("treats a legacy binding without a socket epoch as offline", () => {
    const socket = unboundSocket();
    const lease = leaseOver([socket]);
    const legacy: LiveCapabilityRecord = {
      ...record,
      providerBinding: { channelKey: "channel-1", leaseKey: "lease-1" },
    };

    expect(lease.hasLease(legacy)).toBe(false);
    expect(lease.bindProvision(legacy, { leaseKey: "channel-1", socketId: "socket-1" })).toBe(
      false,
    );
  });

  it("closes stale same-key sockets when the exact relay claims its lease", () => {
    const expected = unboundSocket();
    const stale = unboundSocket("channel-1", "socket-stale");
    const lease = leaseOver([expected, stale]);

    expect(lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" })).toBe(true);

    expect(expected.closed).toEqual([]);
    expect(stale.closed).toEqual([{ code: 1000, reason: "superseded" }]);
    expect(expected.attachment).toEqual({
      channelKey: "channel-1",
      socketId: "socket-1",
      v: 2,
    });
  });

  it("retires one logical lease without closing its shared channel or sibling", async () => {
    const socket = unboundSocket();
    const lease = leaseOver([socket]);
    const sibling: LiveCapabilityRecord = {
      path: ["sibling"],
      providerBinding: { channelKey: "channel-1", leaseKey: "lease-2", socketId: "socket-1" },
      providedAtOffset: 8,
      type: "live",
    };
    lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });
    lease.bindProvision(sibling, { leaseKey: "channel-1", socketId: "socket-1" });

    lease.remove(record);
    expect(socket.sent).toEqual(['{"type":"retire","leaseKey":"lease-1"}']);
    expect(socket.closed).toEqual([]);

    const invocation = lease.invoke(sibling, ["echo"], ["still alive"]);
    const siblingProvider = provider((value) => value);
    lease.activate(
      {
        invoker: siblingProvider.stub,
        channelKey: "channel-1",
        leaseKey: "lease-2",
        path: sibling.path,
        providedAtOffset: sibling.providedAtOffset,
        socketId: "socket-1",
      },
      sibling,
    );
    await expect(invocation).resolves.toBe("still alive");
    expect(socket.closed).toEqual([]);
  });

  it("releases exact retirement guards only after every overlapping mutation settles", () => {
    const socket = unboundSocket();
    const lease = leaseOver([socket]);
    lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });

    const first = lease.remove(record, { notifyRelay: false });
    const second = lease.remove(record, { notifyRelay: false });
    expect(lease.hasLease(record)).toBe(false);

    first[Symbol.dispose]();
    expect(lease.hasLease(record)).toBe(false);
    second[Symbol.dispose]();
    expect(lease.hasLease(record)).toBe(true);
  });

  it("prunes ambiguous retirement and departure guards from caught-up durable state", () => {
    const socket = unboundSocket();
    const sockets = [socket];
    const lease = leaseOver(sockets);
    lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });
    lease.remove(record, { notifyRelay: false });
    lease.departedOnClose(socket);
    expect(lease.hasLease(record)).toBe(false);

    lease.settleDurableState([]);
    expect(lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" })).toBe(
      false,
    );

    socket.closed.push({ code: 1000, reason: "test departure" });
    lease.settleDurableState([]);
    sockets.push(unboundSocket());

    expect(lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" })).toBe(true);
  });

  it("fails an invalid provider attach without closing its sibling's shared channel", async () => {
    const socket = unboundSocket();
    const lease = leaseOver([socket]);
    const sibling: LiveCapabilityRecord = {
      path: ["sibling"],
      providerBinding: { channelKey: "channel-1", leaseKey: "lease-2", socketId: "socket-1" },
      providedAtOffset: 8,
      type: "live",
    };
    lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });
    lease.bindProvision(sibling, { leaseKey: "channel-1", socketId: "socket-1" });

    const invalidInvocation = lease.invoke(record, ["value"], []);
    expect(() =>
      lease.activate(
        {
          invoker: {},
          channelKey: "channel-1",
          leaseKey: "lease-1",
          path: record.path,
          providedAtOffset: record.providedAtOffset,
          socketId: "socket-1",
        },
        record,
      ),
    ).toThrow("attach requires an invoker RPC target");
    await expect(invalidInvocation).rejects.toThrow("attach requires an invoker RPC target");
    expect(socket.closed).toEqual([]);

    const siblingInvocation = lease.invoke(sibling, ["value"], ["still healthy"]);
    const siblingProvider = provider((value) => value);
    lease.activate(
      {
        invoker: siblingProvider.stub,
        channelKey: "channel-1",
        leaseKey: "lease-2",
        path: sibling.path,
        providedAtOffset: sibling.providedAtOffset,
        socketId: "socket-1",
      },
      sibling,
    );
    await expect(siblingInvocation).resolves.toBe("still healthy");
    expect(socket.closed).toEqual([]);
  });

  it("times out only the waiting call and can wake the same healthy provision again", async () => {
    vi.useFakeTimers();
    try {
      const socket = unboundSocket();
      const lease = leaseOver([socket]);
      lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });

      const timedOut = lease.invoke(record, ["echo"], ["first"]);
      const rejection = expect(timedOut).rejects.toThrow("provider did not attach within 10000ms");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(socket.closed).toEqual([]);

      const recovered = lease.invoke(record, ["echo"], ["second"]);
      expect(socket.sent).toEqual([
        '{"type":"wake","leaseKey":"lease-1"}',
        '{"type":"wake","leaseKey":"lease-1"}',
      ]);
      const liveProvider = provider((value) => value);
      expect(
        lease.activate(
          {
            invoker: liveProvider.stub,
            channelKey: "channel-1",
            leaseKey: "lease-1",
            path: record.path,
            providedAtOffset: record.providedAtOffset,
            socketId: "socket-1",
          },
          record,
        ),
      ).not.toBeUndefined();
      await expect(recovered).resolves.toBe("second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still releases the relay-side session anchor when provider disposal reports an error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const socket = unboundSocket();
    const lease = leaseOver([socket]);
    lease.bindProvision(record, { leaseKey: "channel-1", socketId: "socket-1" });

    const invocation = lease.invoke(record, ["echo"], ["value"]);
    const liveProvider = provider((value) => value);
    liveProvider.retainedDispose.mockImplementation(() => {
      throw new Error("dispose broke");
    });
    lease.activate(
      {
        invoker: liveProvider.stub,
        channelKey: "channel-1",
        leaseKey: "lease-1",
        path: record.path,
        providedAtOffset: record.providedAtOffset,
        socketId: "socket-1",
      },
      record,
    );

    await expect(invocation).resolves.toBe("value");
    expect(socket.sent).toEqual([
      '{"type":"wake","leaseKey":"lease-1"}',
      '{"type":"idle","leaseKey":"lease-1"}',
    ]);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});
