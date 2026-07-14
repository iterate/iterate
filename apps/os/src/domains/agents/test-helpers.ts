// Shared in-memory harness for agent processor tests: a Stream implementation
// and cursor-based delivery mirroring production subscription semantics.

import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import { emptyStreamRuntimeState } from "../streams/test-helpers.ts";

export class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  constructor(readonly path = "/agents/test") {}

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
        // Wall-clock createdAt: expiry/backstop fold from createdAt, so epoch
        // timestamps from offsets would mark every request expired immediately.
        createdAt: new Date().toISOString(),
        offset,
        path: this.path,
      };
      this.events.push(event);
      return event;
    });
    return appended;
  }

  async appendAck(...inputs: StreamEventInput[]): Promise<void> {
    await this.append(...inputs);
  }

  async appendOffsets(...inputs: StreamEventInput[]): Promise<number[]> {
    return (await this.append(...inputs)).map((event) => event.offset);
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

  async head() {
    return { createdAt: this.events[0]?.createdAt, maxOffset: this.events.at(-1)?.offset ?? 0 };
  }

  async runtimeState() {
    return emptyStreamRuntimeState();
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }

  async acceptCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement acceptCrossPost().");
  }

  async kill(): Promise<void> {}

  async crossPostTo(): Promise<never> {
    throw new Error("MemoryStream does not implement crossPostTo().");
  }

  async removeCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement removeCrossPost().");
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
