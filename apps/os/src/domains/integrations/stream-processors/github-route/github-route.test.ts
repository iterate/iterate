import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "@iterate-com/streams/shared/event";
import { GithubRouteProcessor } from "./implementation.ts";

describe("GithubRouteProcessor", () => {
  it("folds declared repo links and forwards matching webhooks to the repo stream", async () => {
    const { appends, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/github/repo-route-configured",
          payload: { fullName: "Iterate/Site", repoStreamPath: "/repos/site" },
        }),
        committedEvent({
          offset: 2,
          type: "events.iterate.com/integration/event-received",
          payload: {
            integration: "github",
            transport: "webhook",
            routingKey: "installation:1234",
            account: "default",
            body: { ref: "refs/heads/main", repository: { full_name: "iterate/site" } },
          },
        }),
      ],
      streamMaxOffset: 2,
    });
    await flushBackgroundWork();

    // Matching is case-insensitive on the GitHub full name.
    expect(processor.state.routes).toEqual({ "iterate/site": "/repos/site" });
    expect(appends).toEqual([
      {
        streamPath: "/repos/site",
        event: {
          type: "events.iterate.com/integration/event-received",
          idempotencyKey: "github-route/forward@2",
          payload: {
            integration: "github",
            transport: "webhook",
            routingKey: "installation:1234",
            account: "default",
            body: { ref: "refs/heads/main", repository: { full_name: "iterate/site" } },
          },
        },
      },
    ]);
  });

  it("ignores webhooks about repositories nobody linked", async () => {
    const { appends, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/integration/event-received",
          payload: {
            integration: "github",
            transport: "webhook",
            routingKey: "installation:1234",
            body: { repository: { full_name: "iterate/unlinked" } },
          },
        }),
      ],
      streamMaxOffset: 1,
    });
    await flushBackgroundWork();

    expect(appends).toEqual([]);
  });

  it("stops forwarding after repo-route-removed", async () => {
    const { appends, processor } = createProcessor();

    await processor.ingest({
      events: [
        committedEvent({
          offset: 1,
          type: "events.iterate.com/github/repo-route-configured",
          payload: { fullName: "iterate/site", repoStreamPath: "/repos/site" },
        }),
        committedEvent({
          offset: 2,
          type: "events.iterate.com/github/repo-route-removed",
          payload: { fullName: "iterate/site" },
        }),
        committedEvent({
          offset: 3,
          type: "events.iterate.com/integration/event-received",
          payload: {
            integration: "github",
            transport: "webhook",
            routingKey: "installation:1234",
            body: { repository: { full_name: "iterate/site" } },
          },
        }),
      ],
      streamMaxOffset: 3,
    });
    await flushBackgroundWork();

    expect(processor.state.routes).toEqual({});
    expect(appends).toEqual([]);
  });
});

function createProcessor() {
  const appends: Array<{ streamPath?: string; event: StreamEventInput }> = [];
  const processor = new GithubRouteProcessor({
    iterateContext: {
      stream: {
        append: async (input: { streamPath?: string; event: StreamEventInput }) => {
          appends.push(input);
          return committedEvent({ ...input.event, offset: 0 });
        },
        appendBatch: async ({ events }: { events: StreamEventInput[] }) =>
          events.map((event) => committedEvent({ ...event, offset: 0 })),
      },
    },
  });
  return { appends, processor };
}

async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function committedEvent(args: {
  type: string;
  payload?: unknown;
  idempotencyKey?: string;
  offset: number;
}): StreamEvent {
  return {
    type: args.type,
    payload: args.payload,
    ...(args.idempotencyKey == null ? {} : { idempotencyKey: args.idempotencyKey }),
    offset: args.offset,
    createdAt: "2026-06-11T00:00:00.000Z",
  };
}
