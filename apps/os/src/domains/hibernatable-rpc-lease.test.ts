import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HibernatableRpcLeaseSockets,
  parseHibernatableRpcLeaseFrame,
} from "./hibernatable-rpc-lease.ts";

const Attachment = z.object({
  leaseKey: z.string(),
  socketId: z.string(),
  state: z.string(),
});

type FakeSocket = WebSocket & {
  attachment: unknown;
  closed: { code?: number; reason?: string }[];
  failSend?: boolean;
  failStamp?: boolean;
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
      if (socket.failSend === true) throw new Error("send broke");
      socket.sent.push(data);
    },
    serializeAttachment(value: unknown) {
      if (socket.failStamp === true) throw new Error("stamp broke");
      socket.attachment = value;
    },
  } as unknown as FakeSocket;
  return socket;
}

function socketsOver(sockets: FakeSocket[]) {
  return new HibernatableRpcLeaseSockets({
    attachmentSchema: Attachment,
    bindingOf: ({ leaseKey, socketId }) => ({ leaseKey, socketId }),
    createAttachment: ({ leaseKey, socketId }) => ({ leaseKey, socketId, state: "new" }),
    headerName: "x-test-lease",
    hooks: {
      acceptWebSocket: () => undefined,
      getWebSockets: () => sockets.filter((socket) => socket.closed.length === 0),
    },
    lane: "test",
    socketTag: "test-lease",
    upgradeSchema: z.object({ leaseKey: z.string(), socketId: z.string() }),
  });
}

describe("hibernatable RPC lease transport", () => {
  it("parses only complete lifecycle frames", () => {
    expect(parseHibernatableRpcLeaseFrame('{"type":"wake"}')).toEqual({ type: "wake" });
    expect(parseHibernatableRpcLeaseFrame('{"type":"idle"}')).toEqual({ type: "idle" });
    expect(parseHibernatableRpcLeaseFrame('{"type":"unknown"}')).toBeUndefined();
    expect(parseHibernatableRpcLeaseFrame("not json")).toBeUndefined();
    expect(parseHibernatableRpcLeaseFrame(new ArrayBuffer(0))).toBeUndefined();
  });

  it("claims the exact socket, closes same-key losers, and ignores invalid attachments", () => {
    const expected = fakeSocket({ leaseKey: "lease", socketId: "expected", state: "new" });
    const loser = fakeSocket({ leaseKey: "lease", socketId: "loser", state: "new" });
    const invalid = fakeSocket({ leaseKey: "lease", socketId: 42, state: "new" });
    const leases = socketsOver([expected, loser, invalid]);

    expect(leases.claim({ leaseKey: "lease", socketId: "expected" })?.ws).toBe(expected);
    expect(loser.closed).toEqual([{ code: 1000, reason: "superseded" }]);
    expect(invalid.closed).toEqual([]);
  });

  it("keeps only the newest duplicate of the exact binding", () => {
    const first = fakeSocket({ leaseKey: "lease", socketId: "same", state: "new" });
    const second = fakeSocket({ leaseKey: "lease", socketId: "same", state: "new" });
    const leases = socketsOver([first, second]);

    expect(leases.claim({ leaseKey: "lease", socketId: "same" })?.ws).toBe(second);
    expect(first.closed).toEqual([{ code: 1000, reason: "superseded" }]);
    expect(second.closed).toEqual([]);
  });

  it("turns attachment and frame failures into terminal channel failures", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stampFailure = fakeSocket({ leaseKey: "one", socketId: "one", state: "new" });
    stampFailure.failStamp = true;
    const sendFailure = fakeSocket({ leaseKey: "two", socketId: "two", state: "new" });
    sendFailure.failSend = true;
    const leases = socketsOver([stampFailure, sendFailure]);

    expect(leases.stamp(stampFailure, { leaseKey: "one", socketId: "one", state: "bound" })).toBe(
      false,
    );
    expect(stampFailure.closed).toEqual([{ code: 1011, reason: "attachment stamp failed" }]);

    expect(leases.send(sendFailure, { type: "wake" })).toBe(false);
    expect(sendFailure.closed).toEqual([{ code: 1011, reason: "wake frame failed" }]);
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("closes an accepted socket when its initial attachment cannot be serialized", () => {
    const server = fakeSocket(undefined);
    server.failStamp = true;
    const client = fakeSocket(undefined);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = client;
        1 = server;
      },
    );
    try {
      const response = socketsOver([]).acceptUpgrade(
        new Request("https://lease.internal/", {
          headers: {
            Upgrade: "websocket",
            "x-test-lease": JSON.stringify({ leaseKey: "lease", socketId: "socket" }),
          },
        }),
      );

      expect(response.status).toBe(500);
      expect(server.closed).toEqual([{ code: 1011, reason: "initial attachment stamp failed" }]);
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
