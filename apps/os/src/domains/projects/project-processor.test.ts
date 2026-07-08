import { describe, expect, it } from "vitest";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
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
        path: this.path,
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
    return { coreProcessorState: null, runtime: { connections: {}, workerDelivery: null } };
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
    path: "/projects/test",
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
    itx,
  });
  return { network, processor };
}

describe("ProjectProcessor agent birth", () => {
  it("appends only processor subscriptions at birth — policy comes from the project worker", async () => {
    const { network, processor } = makeHarness();

    await processor.ingest({
      events: [
        event("events.iterate.com/stream/child-stream-created", {
          childPath: "/agents/demo",
        }),
      ],
      streamMaxOffset: 1,
    });

    // Mechanics only. System prompt, provider selection, capability mounts,
    // and boot context are appended by the project worker via
    // itx.agents.defaults (see agents/agent-defaults.test.ts).
    const born = network.eventsAt("/agents/demo").map((streamEvent) => streamEvent.type);
    expect(born).toEqual([
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
  });
});
