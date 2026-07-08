import { describe, expect, it } from "vitest";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  constructor(readonly path: string) {}

  async __describe() {
    return { instructions: `in-memory stream ${this.path}`, types: "", children: {} };
  }

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;

      const offset = this.events.length + 1;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(offset).toISOString(),
        offset,
      };
      this.events.push(event);
      return event;
    });
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
    const match = this.events.find((event) => {
      if (input.afterOffset !== undefined && event.offset <= input.afterOffset) return false;
      if (input.eventTypes !== undefined && !input.eventTypes.includes(event.type)) return false;
      return true;
    });
    if (match !== undefined && (input.predicate === undefined || (await input.predicate(match)))) {
      return match;
    }
    throw new Error("MemoryStream timed out waiting for event");
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

class MemoryStreamNetwork {
  readonly streams = new Map<string, MemoryStream>();

  get(path: string): MemoryStream {
    let stream = this.streams.get(path);
    if (stream === undefined) {
      stream = new MemoryStream(path);
      this.streams.set(path, stream);
    }
    return stream;
  }

  eventsAt(path: string): StreamEvent[] {
    return this.get(path).events;
  }
}

function event(type: string, payload: Record<string, unknown>, offset = 1): StreamEvent {
  return {
    type,
    payload,
    createdAt: new Date(offset).toISOString(),
    offset,
  };
}

function makeHarness() {
  const network = new MemoryStreamNetwork();
  const itx = {
    projectId: "prj_test",
    streams: { get: (path: string) => network.get(path) },
  } as unknown as ProjectRpcTarget;
  const processor = new ProjectProcessor({
    stream: network.get("/"),
    defaultLlmProvider: "openai-ws",
    itx,
  });
  return { network, processor };
}

describe("ProjectProcessor agent birth", () => {
  it("mounts no capabilities at birth — sandboxes are created explicitly, never granted", async () => {
    const { network, processor } = makeHarness();

    await processor.ingest({
      events: [
        event("events.iterate.com/stream/child-stream-created", {
          childPath: "/agents/demo",
        }),
      ],
      streamMaxOffset: 1,
    });

    const capabilityMounts = network
      .eventsAt("/agents/demo")
      .filter(
        (streamEvent) =>
          streamEvent.type === "events.iterate.com/capability-host/capability-provided",
      );
    expect(capabilityMounts).toEqual([]);
  });
});
