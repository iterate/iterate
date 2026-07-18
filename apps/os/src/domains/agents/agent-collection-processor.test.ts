import { describe, expect, test } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { StreamProcessorRunner } from "iterate/processors";
import type { Stream } from "../../itx-api.generated.ts";
import {
  AGENT_COLLECTION_CREATED_EVENT_TYPE,
  AgentCollectionProcessorContract,
} from "./agent-collection-processor-contract.ts";
import { AgentCollectionStreamProcessor } from "./agent-collection-processor-implementation.ts";

const neverStream = new Proxy({} as Stream, {
  get(_target, property) {
    throw new Error(`Unexpected stream access: ${String(property)}`);
  },
});

function subject() {
  const processor = new AgentCollectionStreamProcessor({
    path: "/agents",
    projectId: "prj_example",
    stream: neverStream,
  });
  const runner = new StreamProcessorRunner({ processor, stream: neverStream });
  return {
    async deliver(events: StreamEvent[]) {
      const opened = await runner.openDelivery();
      await opened.sink({
        events,
        scannedAfterOffset: opened.checkpointOffset,
        scannedThroughOffset: events.at(-1)?.offset ?? opened.checkpointOffset,
        streamMaxOffset: events.at(-1)?.offset ?? opened.checkpointOffset,
      });
    },
    snapshot: () => runner.snapshot(),
  };
}

function collectionCreated(): StreamEvent {
  return {
    createdAt: "2026-07-18T10:00:00.000Z",
    offset: 1,
    path: "/agents",
    payload: {},
    type: AGENT_COLLECTION_CREATED_EVENT_TYPE,
  };
}

function copiedAgentEvent(
  offset: number,
  type: "events.iterate.com/agent/created" | "events.iterate.com/agent/metadata-changed",
  payload: Record<string, unknown>,
  path = "/agents/researcher",
  sourceOffset = offset,
): StreamEvent {
  const sourceCreatedAt = new Date(
    Date.parse("2026-07-18T10:00:00.000Z") + sourceOffset * 1_000,
  ).toISOString();
  // The collection copy may arrive much later than the source fact. Reduced
  // catalogue timestamps must preserve source chronology, not ingest delay.
  const createdAt = new Date(Date.parse(sourceCreatedAt) + 60_000).toISOString();
  return {
    createdAt,
    offset,
    path: "/agents",
    payload,
    source: {
      crossPostedFrom: [
        {
          subscriptionKey: "agent-collection",
          createdAt: sourceCreatedAt,
          offset: sourceOffset,
          path,
          projectId: "prj_example",
          type,
        },
      ],
    },
    type,
  };
}

describe("AgentCollectionStreamProcessor", () => {
  test("reduces created and metadata copies into the agent database", async () => {
    const driver = subject();
    await driver.deliver([
      collectionCreated(),
      copiedAgentEvent(2, "events.iterate.com/agent/created", {}),
      copiedAgentEvent(3, "events.iterate.com/agent/metadata-changed", {
        title: "Release researcher",
        activity: "Checking CI",
      }),
    ]);

    await expect(driver.snapshot()).resolves.toMatchObject({
      state: {
        birthCertificate: {},
        agents: {
          "/agents/researcher": {
            path: "/agents/researcher",
            metadata: {
              pinned: false,
              title: "Release researcher",
              activity: "Checking CI",
            },
            timestamps: {
              createdAt: "2026-07-18T10:00:02.000Z",
              lastWorkAt: "2026-07-18T10:00:03.000Z",
              metadataUpdatedAt: "2026-07-18T10:00:03.000Z",
            },
          },
        },
      },
    });
  });

  test("refolds deterministically and rejects agent facts without provenance", async () => {
    const events = [
      collectionCreated(),
      copiedAgentEvent(2, "events.iterate.com/agent/created", {}),
      copiedAgentEvent(3, "events.iterate.com/agent/metadata-changed", { pinned: true }),
    ];
    const first = subject();
    const second = subject();
    await first.deliver(events);
    await second.deliver(events);
    expect((await first.snapshot()).state).toEqual((await second.snapshot()).state);

    const invalid = subject();
    await expect(
      invalid.deliver([
        collectionCreated(),
        {
          createdAt: "2026-07-18T10:00:02.000Z",
          offset: 2,
          path: "/agents",
          payload: {},
          type: "events.iterate.com/agent/created",
        },
      ]),
    ).rejects.toThrow("without cross-post provenance");
  });

  test("a delayed conditional metadata clear cannot erase a newer wait", async () => {
    const driver = subject();
    await driver.deliver([
      collectionCreated(),
      copiedAgentEvent(2, "events.iterate.com/agent/created", {}, "/agents/researcher", 1),
      copiedAgentEvent(
        3,
        "events.iterate.com/agent/metadata-changed",
        { waitingFor: "user_input" },
        "/agents/researcher",
        2,
      ),
      copiedAgentEvent(
        4,
        "events.iterate.com/agent/metadata-changed",
        { waitingFor: "timer" },
        "/agents/researcher",
        4,
      ),
      copiedAgentEvent(
        5,
        "events.iterate.com/agent/metadata-changed",
        { waitingFor: null, clearWaitingForThroughOffset: 3 },
        "/agents/researcher",
        5,
      ),
    ]);

    await expect(driver.snapshot()).resolves.toMatchObject({
      state: {
        agents: {
          "/agents/researcher": { metadata: { waitingFor: "timer" } },
        },
        waitingForSinceOffsets: { "/agents/researcher": 4 },
      },
    });
  });

  test("contract consumes only collection birth, agent creation, and metadata", () => {
    expect(AgentCollectionProcessorContract.consumes).toEqual([
      AGENT_COLLECTION_CREATED_EVENT_TYPE,
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/metadata-changed",
    ]);
  });
});
