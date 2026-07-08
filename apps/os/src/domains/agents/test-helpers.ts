// Shared in-memory harness for agent/provider processor tests: a Stream
// implementation, cursor-based delivery mirroring production subscription
// semantics, and a fake OpenAI Responses WebSocket. Used by
// agent-processors.test.ts and the stream-repros/ tests.

import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import type { OpenAiResponsesWebSocket } from "./openai-ws-processor-implementation.ts";

export class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    const appended = inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      // Next offset comes from the last event, not the array length — seeded
      // histories (e.g. stream-repros fixtures with bulk event types dropped)
      // have offset gaps.
      const offset = (this.events.at(-1)?.offset ?? 0) + 1;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(offset).toISOString(),
        offset,
      };
      this.events.push(event);
      return event;
    });
    return appended;
  }

  at(): Stream {
    return this;
  }

  async getEvent(
    input: { offset: number } | { idempotencyKey: string },
  ): Promise<StreamEvent | undefined> {
    if ("offset" in input) return this.events.find((event) => event.offset === input.offset);
    return this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  }

  async getEvents(input: Parameters<Stream["getEvents"]>[0] = {}): Promise<StreamEvent[]> {
    const { afterOffset = 0, limit = 500 } = input;
    const beforeOffset = input.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.events
      .filter((event) => event.offset > afterOffset)
      .filter((event) => event.offset < beforeOffset)
      .filter(
        (event) =>
          input.eventTypes === undefined ||
          input.eventTypes.includes("*") ||
          input.eventTypes.includes(event.type),
      )
      .slice(0, limit);
  }

  readEvents(input: Parameters<Stream["readEvents"]>[0] = {}) {
    let afterOffset = input.afterOffset ?? 0;
    return {
      next: async () => {
        const page = await this.getEvents({ ...input, afterOffset });
        afterOffset = page.at(-1)?.offset ?? afterOffset;
        return page;
      },
      [Symbol.dispose]() {},
    };
  }

  async waitForEvent(input: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate?: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent> {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      for (const event of this.events) {
        if (input.afterOffset !== undefined && event.offset <= input.afterOffset) continue;
        if (input.eventTypes !== undefined && !input.eventTypes.includes(event.type)) continue;
        if (input.predicate !== undefined && !(await input.predicate(event))) continue;
        return event;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for event");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return { coreProcessorState: null, runtime: { connections: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }
}

export type ProcessorLike = {
  ingest(input: { events: StreamEvent[]; streamMaxOffset: number }): Promise<void>;
};

export async function deliverNewEvents(input: {
  processor: ProcessorLike;
  stream: MemoryStream;
  cursors: Map<object, number>;
}) {
  const cursor = input.cursors.get(input.processor) ?? 0;
  const events = input.stream.events.slice(cursor);
  input.cursors.set(input.processor, input.stream.events.length);
  if (events.length === 0) return;
  const streamMaxOffset = input.stream.events.at(-1)?.offset ?? 0;
  await input.processor.ingest({ events, streamMaxOffset });
}

export type FakeResponsesWebSocket = OpenAiResponsesWebSocket & { sent: unknown[] };

/**
 * In-memory OpenAI Responses WebSocket: `sendResponseCreate` computes the
 * response frames for the request and feeds them to the messages iterator.
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
