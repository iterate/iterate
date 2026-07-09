// Agent-domain test helpers: the shared stream fakes live in
// ../streams/test-helpers.ts (re-exported here so agent tests keep one
// import); this file adds the fake OpenAI Responses WebSocket.

import type { OpenAiResponsesWebSocket } from "./openai-ws-processor-implementation.ts";

export { MemoryStream, deliverNewEvents, type ProcessorLike } from "../streams/test-helpers.ts";

export type FakeResponsesWebSocket = OpenAiResponsesWebSocket & { sent: unknown[] };

/**
 * In-memory OpenAI Responses WebSocket: `sendResponseCreate` computes the
 * response frames for the request and feeds them to the messages iterator.
 * A `respond` that returns `[]` accepts the request and then hangs forever —
 * the vendor-side wedge/eviction fixture.
 */
export function fakeResponsesWebSocket(
  respond: (request: unknown) => unknown[],
): FakeResponsesWebSocket {
  const queue: unknown[] = [];
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  const push = (frame: unknown) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter({ value: frame, done: false });
    else queue.push(frame);
  };
  const socket: FakeResponsesWebSocket & { readyState: number } = {
    sent: [],
    readyState: 1,
    sendResponseCreate(event: unknown) {
      socket.sent.push(event);
      for (const frame of respond(event)) push(frame);
    },
    messages(): AsyncIterableIterator<unknown> {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (queue.length > 0) return { value: queue.shift(), done: false };
          return await new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
        },
      };
    },
    close() {
      socket.readyState = 3;
    },
  };
  return socket;
}
