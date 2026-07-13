import { describe, expect, it } from "vitest";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { emptyStreamRuntimeState } from "../streams/test-helpers.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  constructor(
    readonly network: MemoryStreamNetwork,
    readonly path: string,
  ) {}

  async __describe() {
    return { instructions: `in-memory stream ${this.path}`, types: "", children: {} };
  }

  async kill(): Promise<void> {}

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

  async appendAck(...inputs: StreamEventInput[]): Promise<void> {
    await this.append(...inputs);
  }

  at(path: string): Stream {
    return this.network.get(path);
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

  async crossPostTo(): Promise<never> {
    throw new Error("MemoryStream does not implement crossPostTo().");
  }

  async removeCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement removeCrossPost().");
  }
}

class MemoryStreamNetwork {
  readonly streams = new Map<string, MemoryStream>();

  get(path: string): MemoryStream {
    let stream = this.streams.get(path);
    if (stream === undefined) {
      stream = new MemoryStream(this, path);
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
    // The repo-created lane probes the default project worker before
    // committing project/created; the fake worker is always ready.
    worker: { fetch: async () => ({}) },
  } as unknown as ProjectRpcTarget;
  const processor = new ProjectProcessor({
    stream: network.get("/"),
    path: "/",
    projectId: "prj_test",
    itx,
  });
  return { network, processor };
}

describe("ProjectProcessor bootstrap", () => {
  it("arms the config repo on its own stream: processor subscription, cross-post to /, create request", async () => {
    const { network, processor } = makeHarness();

    await processor.ingest({
      events: [
        event("events.iterate.com/project/create-requested", {
          projectId: "prj_test",
          slug: "demo",
        }),
      ],
      streamMaxOffset: 1,
    });

    const configRepo = network.eventsAt("/repos/config");
    expect(configRepo.map((streamEvent) => streamEvent.type)).toEqual([
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/repo/create-requested",
    ]);
    // The cross-post rule copies EVERY config-repo event onto the project
    // stream `/` — full history, so the saga's repo/created arrives too.
    expect(configRepo[1]!.payload).toMatchObject({
      subscriptionKey: "cross-post:/",
      delivery: { mode: "push", expression: ["streams", ["get", "/"], "acceptCrossPost"] },
      deliver: "all",
    });
    expect(configRepo[2]!.payload).toEqual({ path: "/repos/config", projectId: "prj_test" });
    // Nothing repo-shaped lands on `/` first-hand anymore; the project stream
    // only carries its own saga events plus cross-posted copies.
    expect(
      network.eventsAt("/").filter((streamEvent) => streamEvent.type.includes("/repo/")),
    ).toEqual([]);
  });

  it("completes the saga from the (cross-posted) repo/created fact for the config repo", async () => {
    const { network, processor } = makeHarness();

    await processor.ingest({
      events: [
        event("events.iterate.com/project/create-requested", {
          projectId: "prj_test",
          slug: "demo",
        }),
      ],
      streamMaxOffset: 1,
    });
    await processor.ingest({
      events: [
        {
          ...event(
            "events.iterate.com/repo/created",
            {
              artifactName: "prj_test--L3JlcG9zL2NvbmZpZw",
              defaultBranch: "main",
              path: "/repos/config",
              projectId: "prj_test",
              remote: "https://example.artifacts.cloudflare.net/git/ns/x.git",
            },
            2,
          ),
          // As delivered on `/`: a cross-posted copy with provenance.
          source: {
            crossPostedFrom: [
              {
                subscriptionKey: "cross-post:/",
                createdAt: new Date(2).toISOString(),
                offset: 4,
                path: "/repos/config",
                projectId: "prj_test",
                type: "events.iterate.com/repo/created",
              },
            ],
          },
        },
      ],
      streamMaxOffset: 2,
    });

    const rootTypes = network.eventsAt("/").map((streamEvent) => streamEvent.type);
    expect(rootTypes).toContain("events.iterate.com/project/created");
  });
});

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

    // Mechanics only. System prompt, model selection, capability mounts,
    // and boot context are appended by the project worker via
    // itx.agents.defaults (see agents/agent-defaults.test.ts).
    const born = network.eventsAt("/agents/demo").map((streamEvent) => streamEvent.type);
    // agent processor + capability-host — no separate LLM provider processors.
    expect(born).toEqual([
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
  });
});
