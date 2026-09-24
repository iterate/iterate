import { expect, test } from "vitest";
import { openSocketWithRetry } from "./socket.ts";

test("a connection that fails twice and opens on the third attempt resolves after two waits", async () => {
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
  expect(Socket.constructions()).toBe(3);
  expect(waits).toEqual([10, 20]);
});

test("a connection that never opens rejects after the last attempt, with every wait spent", async () => {
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
  ).rejects.toThrow("WebSocket connection failed.");
  expect(Socket.constructions()).toBe(3);
  expect(waits).toEqual([1, 2]);
});

test("a connection that opens first time makes one attempt and no wait", async () => {
  const Socket = fakeSocketClass(0);
  await openSocketWithRetry("wss://example.test/api", { WebSocket: Socket, delaysMs: [1] });
  expect(Socket.constructions()).toBe(1);
});

/** A WebSocket that fails its first `failures` constructions (a `close` before `open`) and opens
 *  every one after — what a flapping connection looks like from the page. */
function fakeSocketClass(failures: number) {
  let constructions = 0;
  class FakeWebSocket extends EventTarget {
    static constructions() {
      return constructions;
    }
    readonly url: string | URL;
    constructor(url: string | URL) {
      super();
      this.url = url;
      constructions += 1;
      const outcome = constructions <= failures ? "close" : "open";
      queueMicrotask(() => this.dispatchEvent(new Event(outcome)));
    }
  }
  return FakeWebSocket as unknown as typeof WebSocket & { constructions(): number };
}
