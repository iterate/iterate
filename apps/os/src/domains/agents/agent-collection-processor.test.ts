// The agent collection's executable spec on the generic step harness from
// iterate/processors/testing: the REAL StreamProcessorRunner over the shared
// MemoryStream. The collection is a pure projector, so scenarios are appends
// of cross-posted agent facts plus assertions on the reduced catalog —
// no side-effect lanes, no crash steps, and the stream never grows beyond
// what the tests append.

import { describe, expect, test, vi } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { AgentCollectionProcessorContract } from "./agent-collection-processor-contract.ts";
import { AgentCollectionStreamProcessor } from "./agent-collection-processor-implementation.ts";

type CollectionEventInput = ConsumedInput<AgentCollectionProcessorContract>;

function makeCollectionHarness(substrate?: HarnessSubstrate) {
  return makeProcessorHarness<AgentCollectionProcessorContract>({
    createProcessor: (deps) => new AgentCollectionStreamProcessor(deps),
    path: "/agents",
    ...(substrate === undefined ? {} : { substrate }),
  });
}

const COLLECTION_CREATED = {
  type: "events.iterate.com/agent-collection/created",
  payload: {},
} satisfies CollectionEventInput;

// -----------------------------------------------------------------------------
// Event builders (data, not append wrappers): copies of agent-stream facts as
// the collection receives them — the payload plus the cross-post hop naming
// the SOURCE stream and the fact's original coordinates. The source commit
// time derives from the source offset (10:00:0<offset> on 2026-07-18), while
// the copy's own commit time comes from the harness's 1970-epoch virtual
// clock — decades apart ON PURPOSE, so timestamp assertions prove the reduced
// catalog preserves source chronology, not ingest delay.
// -----------------------------------------------------------------------------

function crossPostHop(type: string, path: string, sourceOffset: number) {
  return {
    crossPostedFrom: [
      {
        subscriptionKey: "agent-collection",
        createdAt: new Date(
          Date.parse("2026-07-18T10:00:00.000Z") + sourceOffset * 1_000,
        ).toISOString(),
        offset: sourceOffset,
        path,
        projectId: "proj_harness",
        type,
      },
    ],
  };
}

function agentCreatedCopy(args: { sourceOffset: number; path?: string }): CollectionEventInput {
  const path = args.path ?? "/agents/researcher";
  return {
    type: "events.iterate.com/agent/created",
    payload: {},
    source: crossPostHop("events.iterate.com/agent/created", path, args.sourceOffset),
  };
}

function summaryUpdatedCopy(
  update: Extract<
    CollectionEventInput,
    { type: "events.iterate.com/agent/summary-updated" }
  >["payload"],
  args: { sourceOffset: number; path?: string },
): CollectionEventInput {
  const path = args.path ?? "/agents/researcher";
  return {
    type: "events.iterate.com/agent/summary-updated",
    payload: update,
    source: crossPostHop("events.iterate.com/agent/summary-updated", path, args.sourceOffset),
  };
}

describe("AgentCollectionStreamProcessor", () => {
  test("reduces created and summary copies into the agent database with source-time stamps", async () => {
    const h = makeCollectionHarness();
    await h.play([
      "append",
      COLLECTION_CREATED,
      agentCreatedCopy({ sourceOffset: 2 }),
      summaryUpdatedCopy(
        { title: "Release researcher", activity: "Checking CI" },
        { sourceOffset: 3 },
      ),
    ]);

    expect(h.state()).toMatchObject({
      birthCertificate: {},
      agents: {
        "/agents/researcher": {
          path: "/agents/researcher",
          summary: { pinned: false, title: "Release researcher", activity: "Checking CI" },
          timestamps: {
            createdAt: "2026-07-18T10:00:02.000Z",
            lastWorkAt: "2026-07-18T10:00:03.000Z",
            summaryUpdatedAt: "2026-07-18T10:00:03.000Z",
            activityUpdatedAt: "2026-07-18T10:00:03.000Z",
          },
        },
      },
    });
    // The copies themselves committed at the harness's 1970-epoch clock; the
    // reduced timestamps above came from the SOURCE hop, not ingest time.
    expect(h.events("events.iterate.com/agent/created")[0]!.createdAt).not.toContain("2026");
  });

  test("a delayed conditional summary clear cannot erase a newer wait", async () => {
    const h = makeCollectionHarness();
    await h.play([
      "append",
      COLLECTION_CREATED,
      agentCreatedCopy({ sourceOffset: 1 }),
      summaryUpdatedCopy({ waitingFor: "user_input" }, { sourceOffset: 2 }),
      summaryUpdatedCopy({ waitingFor: "timer" }, { sourceOffset: 4 }),
      // The clear was decided against the wait set at source offset 2, but a
      // newer wait (offset 4) landed first — the guard drops the stale clear.
      summaryUpdatedCopy(
        { waitingFor: null, clearWaitingForThroughOffset: 3 },
        { sourceOffset: 5 },
      ),
    ]);

    expect(h.state()).toMatchObject({
      agents: { "/agents/researcher": { summary: { waitingFor: "timer" } } },
      waitingForSinceOffsets: { "/agents/researcher": 4 },
    });
  });

  test("a full replay (fresh cursor over the same stream) reduces to the identical catalog and appends nothing", async () => {
    const h = makeCollectionHarness();
    await h.play([
      "append",
      COLLECTION_CREATED,
      agentCreatedCopy({ sourceOffset: 2 }),
      summaryUpdatedCopy({ pinned: true }, { sourceOffset: 3 }),
    ]);
    const committedOffsets = h.events().map((row) => row.offset);

    const replay = makeCollectionHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(),
    });
    await replay.settle(); // replays the whole stream from offset zero

    expect(replay.state()).toEqual(h.state());
    // A pure projector: replaying must not have grown the stream.
    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
  });

  test("skips an agent copy without provenance and continues reducing later facts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = makeCollectionHarness();
      await h.play(["append", COLLECTION_CREATED]);
      const beforeMalformedCopy = h.state();

      await h.play(["append", { type: "events.iterate.com/agent/created", payload: {} }]);
      expect(h.state()).toEqual(beforeMalformedCopy);
      expect(consoleError).toHaveBeenCalledWith(
        "agent collection skipped events.iterate.com/agent/created: missing cross-post provenance",
      );

      await h.play([
        "append",
        agentCreatedCopy({ sourceOffset: 2 }),
        summaryUpdatedCopy({ pinned: true }, { sourceOffset: 3 }),
      ]);
      expect(h.state().agents["/agents/researcher"]?.summary.pinned).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("skips a summary before agent creation and continues reducing later facts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = makeCollectionHarness();
      await h.play(["append", COLLECTION_CREATED]);
      const beforeOutOfOrderSummary = h.state();

      await h.play(["append", summaryUpdatedCopy({ pinned: true }, { sourceOffset: 2 })]);
      expect(h.state()).toEqual(beforeOutOfOrderSummary);
      expect(consoleError).toHaveBeenCalledWith(
        "agent collection skipped events.iterate.com/agent/summary-updated for /agents/researcher: agent/created has not been reduced",
      );

      await h.play([
        "append",
        agentCreatedCopy({ sourceOffset: 3 }),
        summaryUpdatedCopy({ pinned: true }, { sourceOffset: 4 }),
      ]);
      expect(h.state().agents["/agents/researcher"]?.summary.pinned).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("ignores duplicate collection and agent creation facts", async () => {
    const duplicateCollection = makeCollectionHarness();
    await duplicateCollection.play(["append", COLLECTION_CREATED, COLLECTION_CREATED]);
    expect(duplicateCollection.state().birthCertificate).toEqual(COLLECTION_CREATED.payload);

    const duplicateAgent = makeCollectionHarness();
    await duplicateAgent.play([
      "append",
      COLLECTION_CREATED,
      agentCreatedCopy({ sourceOffset: 1 }),
      agentCreatedCopy({ sourceOffset: 5 }),
    ]);
    expect(Object.keys(duplicateAgent.state().agents)).toEqual(["/agents/researcher"]);
  });

  test("the contract consumes only collection birth, agent creation, and summary facts", () => {
    expect(AgentCollectionProcessorContract.consumes).toEqual([
      "events.iterate.com/agent-collection/created",
      "events.iterate.com/agent/created",
      "events.iterate.com/agent/summary-updated",
    ]);
  });
});
