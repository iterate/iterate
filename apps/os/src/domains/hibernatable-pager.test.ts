import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HibernatablePagers, parseHibernatablePage } from "./hibernatable-pager.ts";

const Attachment = z.object({
  pagerId: z.string(),
  pagerKey: z.string(),
  state: z.string(),
});

const ControlPage = z.union([
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("page") }),
]);

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
  return new HibernatablePagers({
    attachmentSchema: Attachment,
    bindingOf: ({ pagerId, pagerKey }) => ({ pagerId, pagerKey }),
    createAttachment: ({ pagerId, pagerKey }) => ({ pagerId, pagerKey, state: "new" }),
    headerName: "x-test-pager",
    hooks: {
      acceptWebSocket: () => undefined,
      getWebSockets: () => sockets.filter((socket) => socket.closed.length === 0),
    },
    lane: "test",
    pagerTag: "test-pager",
    upgradeSchema: z.object({ pagerId: z.string(), pagerKey: z.string() }),
  });
}

describe("Hibernatable Pager transport", () => {
  it("parses only complete lane-owned Pages", () => {
    expect(parseHibernatablePage('{"type":"page"}', ControlPage)).toEqual({ type: "page" });
    expect(parseHibernatablePage('{"type":"idle"}', ControlPage)).toEqual({ type: "idle" });
    expect(parseHibernatablePage('{"type":"unknown"}', ControlPage)).toBeUndefined();
    expect(parseHibernatablePage("not json", ControlPage)).toBeUndefined();
    expect(parseHibernatablePage(new ArrayBuffer(0), ControlPage)).toBeUndefined();
  });

  it("claims the exact socket, closes same-key losers, and ignores invalid attachments", () => {
    const expected = fakeSocket({ pagerId: "expected", pagerKey: "pager", state: "new" });
    const loser = fakeSocket({ pagerId: "loser", pagerKey: "pager", state: "new" });
    const invalid = fakeSocket({ pagerId: 42, pagerKey: "pager", state: "new" });
    const pagers = socketsOver([expected, loser, invalid]);

    expect(pagers.claim({ pagerId: "expected", pagerKey: "pager" })?.ws).toBe(expected);
    expect(loser.closed).toEqual([{ code: 1000, reason: "superseded" }]);
    expect(invalid.closed).toEqual([]);
  });

  it("keeps only the newest duplicate of the exact binding", () => {
    const first = fakeSocket({ pagerId: "same", pagerKey: "pager", state: "new" });
    const second = fakeSocket({ pagerId: "same", pagerKey: "pager", state: "new" });
    const pagers = socketsOver([first, second]);

    expect(pagers.claim({ pagerId: "same", pagerKey: "pager" })?.ws).toBe(second);
    expect(first.closed).toEqual([{ code: 1000, reason: "superseded" }]);
    expect(second.closed).toEqual([]);
  });

  it("turns attachment and frame failures into terminal channel failures", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stampFailure = fakeSocket({ pagerId: "one", pagerKey: "one", state: "new" });
    stampFailure.failStamp = true;
    const sendFailure = fakeSocket({ pagerId: "two", pagerKey: "two", state: "new" });
    sendFailure.failSend = true;
    const pagers = socketsOver([stampFailure, sendFailure]);

    expect(pagers.stamp(stampFailure, { pagerId: "one", pagerKey: "one", state: "bound" })).toBe(
      false,
    );
    expect(stampFailure.closed).toEqual([{ code: 1011, reason: "attachment stamp failed" }]);

    expect(pagers.page(sendFailure, { type: "page" })).toBe(false);
    expect(sendFailure.closed).toEqual([{ code: 1011, reason: "Page failed" }]);
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
        new Request("https://pager.internal/", {
          headers: {
            Upgrade: "websocket",
            "x-test-pager": JSON.stringify({ pagerId: "pager", pagerKey: "pager" }),
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
