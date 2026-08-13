import { describe, expect, it, vi } from "vitest";
import type { CapabilityRecord } from "./types.ts";
import { CapabilityProviderPagers } from "./capability-provider-pager.ts";

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
    get readyState() {
      return !socket.closed.length ? 1 : 2;
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

function pagersOver(sockets: FakeSocket[]) {
  return new CapabilityProviderPagers({
    acceptWebSocket: () => undefined,
    getWebSockets: () => sockets.filter((socket) => !socket.closed.length),
  });
}

function record(providedAtOffset: number, path: string[]): LiveCapabilityRecord {
  return {
    path,
    providerPager: { connectedAtOffset: 5 },
    providedAtOffset,
    type: "live",
  };
}

function connectedSocket(): FakeSocket {
  return fakeSocket({
    v: 1,
    connectedAtOffset: 5,
    pagerDialId: "dial-1",
    state: "connected",
  });
}

function provider(result: (value: string) => unknown) {
  const retainedDispose = vi.fn();
  const invoke = vi.fn((_path: string[], args: unknown[]) => result(args[0] as string));
  class FakeInvokerStub {
    dup = vi.fn(() => ({
      [Symbol.dispose]: retainedDispose,
      invoke,
    }));
  }
  return { invoke, retainedDispose, stub: new FakeInvokerStub() };
}

function activate(
  pagers: CapabilityProviderPagers,
  capabilityRecord: LiveCapabilityRecord,
  capabilityProvider: ReturnType<typeof provider>,
) {
  return pagers.activate(
    {
      connectedAtOffset: capabilityRecord.providerPager.connectedAtOffset,
      invoker: capabilityProvider.stub,
      providedAtOffset: capabilityRecord.providedAtOffset,
    },
    capabilityRecord,
  );
}

describe("CapabilityProviderPagers", () => {
  it("binds a connected event offset to the exact transport-only dial id", () => {
    const expected = fakeSocket({ v: 1, pagerDialId: "dial-1", state: "opening" });
    const other = fakeSocket({ v: 1, pagerDialId: "dial-2", state: "opening" });
    const pagers = pagersOver([expected, other]);

    expect(pagers.connect("dial-1", 5)).toBe(true);
    expect(expected.attachment).toEqual({
      v: 1,
      connectedAtOffset: 5,
      pagerDialId: "dial-1",
      state: "connected",
    });
    expect(pagers.hasPager(5)).toBe(true);
    expect(other.closed).toEqual([]);
  });

  it("Pages two mounts independently through one Pager", async () => {
    const socket = connectedSocket();
    const pagers = pagersOver([socket]);
    const firstRecord = record(7, ["first"]);
    const secondRecord = record(8, ["second"]);

    const first = pagers.invoke(firstRecord, ["echo"], ["one"]);
    const second = pagers.invoke(secondRecord, ["echo"], ["two"]);
    expect(socket.sent).toEqual([
      '{"type":"activate","providedAtOffset":7}',
      '{"type":"activate","providedAtOffset":8}',
    ]);

    const firstProvider = provider((value) => `first ${value}`);
    const secondProvider = provider((value) => `second ${value}`);
    expect(activate(pagers, firstRecord, firstProvider)).not.toBeUndefined();
    expect(activate(pagers, secondRecord, secondProvider)).not.toBeUndefined();

    await expect(Promise.all([first, second])).resolves.toEqual(["first one", "second two"]);
    expect(socket.sent.slice(2)).toEqual([
      '{"type":"idle","providedAtOffset":7}',
      '{"type":"idle","providedAtOffset":8}',
    ]);
  });

  it("retires one mount without closing its sibling's Pager", () => {
    const socket = connectedSocket();
    const pagers = pagersOver([socket]);

    pagers.removeMount(record(7, ["first"]));

    expect(socket.sent).toEqual(['{"type":"retire","providedAtOffset":7}']);
    expect(socket.closed).toEqual([]);
    expect(pagers.hasPager(5)).toBe(true);
  });

  it("rejects an activation from a different connected Pager", async () => {
    const socket = connectedSocket();
    const pagers = pagersOver([socket]);
    const capabilityRecord = record(7, ["tools"]);
    const invocation = pagers.invoke(capabilityRecord, ["echo"], ["never"]);
    const capabilityProvider = provider((value) => value);

    expect(
      pagers.activate(
        {
          connectedAtOffset: 999,
          invoker: capabilityProvider.stub,
          providedAtOffset: capabilityRecord.providedAtOffset,
        },
        capabilityRecord,
      ),
    ).toBeUndefined();
    pagers.removeMount(capabilityRecord);
    await expect(invocation).rejects.toThrow('capability "tools" is offline');
  });

  it("reconstructs the Pager from its socket attachment after hibernation", async () => {
    const socket = connectedSocket();
    const reconstructed = pagersOver([socket]);
    const capabilityRecord = record(7, ["tools"]);
    const invocation = reconstructed.invoke(capabilityRecord, ["echo"], ["after hibernation"]);
    const capabilityProvider = provider((value) => value);
    expect(activate(reconstructed, capabilityRecord, capabilityProvider)).not.toBeUndefined();

    await expect(invocation).resolves.toBe("after hibernation");
    expect(socket.sent).toEqual([
      '{"type":"activate","providedAtOffset":7}',
      '{"type":"idle","providedAtOffset":7}',
    ]);
  });

  it("times out a missing provider leg and can Page the mount again", async () => {
    vi.useFakeTimers();
    try {
      const socket = connectedSocket();
      const pagers = pagersOver([socket]);
      const capabilityRecord = record(7, ["tools"]);

      const timedOut = pagers.invoke(capabilityRecord, ["echo"], ["first"]);
      const rejection = expect(timedOut).rejects.toThrow("did not activate within 10000ms");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;

      const recovered = pagers.invoke(capabilityRecord, ["echo"], ["second"]);
      const capabilityProvider = provider((value) => value);
      expect(activate(pagers, capabilityRecord, capabilityProvider)).not.toBeUndefined();
      await expect(recovered).resolves.toBe("second");
      expect(socket.sent).toEqual([
        '{"type":"activate","providedAtOffset":7}',
        '{"type":"activate","providedAtOffset":7}',
        '{"type":"idle","providedAtOffset":7}',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
