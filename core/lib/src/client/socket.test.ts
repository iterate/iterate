import { expect, test, vi } from "vitest";
import { openSocketWithRetry } from "./socket.ts";

test("openSocketWithRetry: a connection that fails twice and opens on the third attempt resolves after two waits, one warn each", async () => {
  const warn = captureWarn();
  const waits: number[] = [];
  const Socket = fakeSocketClass(2);
  const socket = await openSocketWithRetry("wss://example.test/api", {
    WebSocket: Socket,
    delaysMs: [10, 20, 40],
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  expect(socket).toBeInstanceOf(Socket);
  expect({ constructions: Socket.constructions(), waits }).toEqual({
    constructions: 3,
    waits: [10, 20],
  });
  expect(warn).toMatchObject({
    calls: [
      {
        event: "client.platform-failure-socket-open",
        url: "wss://example.test/api",
        attempt: 1,
        attempts: 4,
        retryInMs: 10,
        message:
          'WebSocket connection failed: closed 1006 "edge said no" before it opened (Received network error or non-101 status code.)',
      },
      { attempt: 2, retryInMs: 20 },
    ],
  });
});

test("openSocketWithRetry: a connection that never opens rejects after the last attempt with its close code and cause, every wait spent", async () => {
  const warn = captureWarn();
  const waits: number[] = [];
  const Socket = fakeSocketClass(Infinity);
  await expect(
    openSocketWithRetry("wss://example.test/api", {
      WebSocket: Socket,
      delaysMs: [1, 2],
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
  ).rejects.toThrow(
    'WebSocket connection failed: closed 1006 "edge said no" before it opened (Received network error or non-101 status code.)',
  );
  expect({ constructions: Socket.constructions(), waits, warns: warn.calls.length }).toEqual({
    constructions: 3,
    waits: [1, 2],
    warns: 2,
  });
});

test("openSocketWithRetry: a connection that opens first time makes one attempt, no wait and no warn", async () => {
  const warn = captureWarn();
  const Socket = fakeSocketClass(0);
  await openSocketWithRetry("wss://example.test/api", { WebSocket: Socket, delaysMs: [1] });
  expect({ constructions: Socket.constructions(), warns: warn.calls.length }).toEqual({
    constructions: 1,
    warns: 0,
  });
});

test("openSocketWithRetry: an attempt whose handshake never answers is closed at the handshake bound, explained and tried again", async () => {
  const warn = captureWarn();
  const Socket = fakeSocketClass(0, { silent: 1 });
  const socket = await openSocketWithRetry("wss://example.test/api", {
    WebSocket: Socket,
    delaysMs: [1],
    handshakeTimeoutMs: 20,
    sleep: async () => {},
  });
  expect(socket).toBeInstanceOf(Socket);
  expect({ constructions: Socket.constructions(), closed: Socket.closed() }).toEqual({
    constructions: 2,
    closed: 1,
  });
  expect(warn).toMatchObject({
    calls: [{ attempt: 1, message: "WebSocket did not open in 20 ms" }],
  });
});

test("openSocketWithRetry: a handshake that never answers on the last attempt rejects, naming the bound", async () => {
  captureWarn();
  const Socket = fakeSocketClass(0, { silent: Infinity });
  await expect(
    openSocketWithRetry("wss://example.test/api", {
      WebSocket: Socket,
      delaysMs: [],
      handshakeTimeoutMs: 20,
    }),
  ).rejects.toThrow("WebSocket did not open in 20 ms");
  expect(Socket.closed()).toBe(1);
});

/** A WebSocket whose first `silent` constructions never answer (no `open`, no `close`: a hung
 *  handshake), whose next `failures` fail — an `error` carrying undici's reason, then a `close` 1006
 *  before `open`, the way Node's WebSocket fails a refused upgrade — and which opens every one
 *  after: what a flapping connection looks like from the page. */
function fakeSocketClass(failures: number, { silent = 0 }: { silent?: number } = {}) {
  let constructions = 0;
  let closed = 0;
  class FakeWebSocket extends EventTarget {
    static constructions() {
      return constructions;
    }
    static closed() {
      return closed;
    }
    readonly url: string | URL;
    constructor(url: string | URL) {
      super();
      this.url = url;
      constructions += 1;
      if (constructions <= silent) return;
      const fails = constructions <= silent + failures;
      queueMicrotask(() => {
        if (!fails) return this.dispatchEvent(new Event("open"));
        this.dispatchEvent(
          Object.assign(new Event("error"), {
            error: new TypeError("Received network error or non-101 status code."),
          }),
        );
        this.dispatchEvent(
          Object.assign(new Event("close"), {
            code: 1006,
            reason: "edge said no",
            wasClean: false,
          }),
        );
      });
    }
    close() {
      closed += 1;
    }
  }
  return FakeWebSocket as unknown as typeof WebSocket & {
    constructions(): number;
    closed(): number;
  };
}

/** console.warn captured for one test; `calls` are the first arguments. */
function captureWarn() {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  return {
    get calls() {
      return spy.mock.calls.map(([first]) => first);
    },
  };
}
