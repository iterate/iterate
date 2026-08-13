// The workspace processor's executable spec on the generic step harness
// (iterate/processors/testing): the REAL StreamProcessorRunner over the
// shared MemoryStream (production idempotency and parse-skip semantics),
// eviction-faithful crash(). Scenarios are ordered steps — typed appends plus
// function steps for the raw (contract-bypassing) appends the malformed-event
// suite needs. The registry-level suite at the bottom keeps its inline
// fake-DurableObjectState harness: it pins the workspace DO's WIRING
// (registry + runner-backed reads), not the processor's reduce.
//
// Since 0.4.0 the processor holds existence plus the mount OVERLAY table
// only: the live routing table is derived from the project's repo list
// (effectiveWorkspaceMounts) with these overlays merged on top, so nothing
// here ever states a complete default mount table.

import { describe, expect, test } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStream,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { WorkspaceProcessorContract } from "./workspace-processor-contract.ts";
import { WorkspaceProcessor } from "./workspace-processor-implementation.ts";
import { workspaceCreationEvents } from "./utils.ts";

const WORKSPACE_PATH = "/workspaces/example";

const iterateOverlay = { policy: "read-only", repoPath: "/repos/iterate" } as const;

const CREATED = {
  type: "events.iterate.com/workspace/created",
  payload: {},
} satisfies ConsumedInput<WorkspaceProcessorContract>;

function makeWorkspaceHarness(substrate?: HarnessSubstrate) {
  return makeProcessorHarness<WorkspaceProcessorContract>({
    createProcessor: (deps) => new WorkspaceProcessor(deps),
    path: WORKSPACE_PATH,
    ...(substrate && { substrate }),
  });
}

describe("WorkspaceProcessor reduce", () => {
  test("the creation batch reduces the existence marker plus the initial overlay patch", async () => {
    const h = makeWorkspaceHarness();
    await h.play(() =>
      h.stream.append(
        ...workspaceCreationEvents({
          mounts: { "/cfg": { policy: "read-only", repoPath: "/repos/config" } },
          path: WORKSPACE_PATH,
          projectId: "prj_example",
        }),
      ),
    );

    expect(h.state()).toMatchObject({
      birthCertificate: {},
      config: {
        mounts: {
          "/cfg": { policy: "read-only", repoPath: "/repos/config" },
        },
      },
    });
  });

  test("created is a pure existence marker — a pre-0.4.0 mount table in the payload is ignored", async () => {
    const h = makeWorkspaceHarness();
    await h.play([
      "append",
      // The old birth shape: payload carried the complete initial config.
      // The loose schema still accepts it; the reduce keeps it as the
      // certificate verbatim but seeds NO overlays from it.
      {
        type: "events.iterate.com/workspace/created",
        payload: { config: { mounts: { "/iterate": iterateOverlay } } },
      },
    ]);

    expect(h.state()).toEqual({
      birthCertificate: { config: { mounts: { "/iterate": iterateOverlay } } },
      config: { mounts: {} },
    });
    // Pure reducer: the stream holds exactly what the test appended — the
    // processor made no appends of its own.
    expect(h.events()).toHaveLength(1);
  });

  test("a configured patch deep-merges per overlay: partial edit, add, and null-clear — across an eviction", async () => {
    const h = makeWorkspaceHarness();
    await h.play(
      [
        "append",
        CREATED,
        {
          type: "events.iterate.com/workspace/configured",
          payload: {
            config: {
              mounts: {
                "/docs": { policy: "read-only", repoPath: "/repos/docs" },
                "/iterate": iterateOverlay,
              },
            },
          },
        },
      ],
      // Eviction between the patches: the successor incarnation resumes from
      // committed progress and reduces on.
      ["crash"],
      [
        "append",
        {
          type: "events.iterate.com/workspace/configured",
          payload: {
            config: {
              mounts: {
                // Partial value: only the policy flips, repoPath is retained.
                "/iterate": { policy: "commit-to-main" },
                // null: clears the overlay (the derived default returns).
                "/docs": null,
              },
            },
          },
        },
      ],
    );

    expect(h.state()).toMatchObject({
      birthCertificate: {},
      config: {
        mounts: {
          "/iterate": { policy: "commit-to-main", repoPath: "/repos/iterate" },
        },
      },
    });
    expect(h.state().config.mounts).not.toHaveProperty("/docs");
    expect(h.events()).toHaveLength(3);
  });

  test("a SECOND created event is skipped — the first certificate wins, the reduce never wedges", async () => {
    const h = makeWorkspaceHarness();
    await h.play([
      "append",
      { type: "events.iterate.com/workspace/created", payload: { origin: "first" } },
      // Raw append under a different idempotency key: schema-valid, must
      // reduce as a no-op rather than throwing the cursor into a wedge.
      { type: "events.iterate.com/workspace/created", payload: { origin: "impostor" } },
    ]);

    expect(h.state().birthCertificate).toEqual({ origin: "first" });
    expect(h.state().config.mounts).toEqual({});
  });

  test("a patch adding an INCOMPLETE overlay is KEPT — a stored deviation, not a complete mount", async () => {
    const h = makeWorkspaceHarness();
    await h.play([
      "append",
      CREATED,
      // Partial values are legal patch entries even at paths with nothing to
      // merge into: the overlay table stores deviations, and only the
      // EFFECTIVE table (effectiveWorkspaceMounts) decides whether they form
      // a complete mount. The reduce must keep it and advance.
      {
        type: "events.iterate.com/workspace/configured",
        payload: { config: { mounts: { "/new": { policy: "read-only" } } } },
      },
      {
        type: "events.iterate.com/workspace/configured",
        payload: {
          config: { mounts: { "/docs": { policy: "read-only", repoPath: "/repos/docs" } } },
        },
      },
    ]);

    expect(h.state().config.mounts).toEqual({
      "/docs": { policy: "read-only", repoPath: "/repos/docs" },
      "/new": { policy: "read-only" },
    });
  });

  test("a NON-CANONICAL raw event fails the contract parse and is skipped, with the skip recorded as a stream error", async () => {
    const h = makeWorkspaceHarness();
    await h.play(
      ["append", CREATED],
      // Raw stream appends (bypassing the contract's typed lane, like a
      // production raw append would): an aliasing mount spelling ("/docs/"
      // vs "/docs") and a codec-unsafe repoPath. Both fail the payload
      // schema, so the runner skips them and the reduce never sees them.
      () =>
        h.stream.append(
          {
            type: "events.iterate.com/workspace/configured",
            payload: {
              config: { mounts: { "/docs/": { policy: "read-only", repoPath: "/repos/docs" } } },
            },
          },
          {
            type: "events.iterate.com/workspace/configured",
            payload: {
              config: {
                mounts: { "/evil": { policy: "read-only", repoPath: "/repos/b?alias=1" } },
              },
            },
          },
        ),
    );

    expect(h.state().config.mounts).toEqual({});
    // Each skip is journaled by the RUNNER (not the processor) as a
    // stream/error-occurred diagnostic pointing at the offending offset.
    expect(h.events("events.iterate.com/stream/error-occurred")).toMatchObject([
      { payload: { message: expect.stringContaining("skipped event at offset 2") } },
      { payload: { message: expect.stringContaining("skipped event at offset 3") } },
    ]);
  });

  test("a full replay (fresh cursor over the same stream) reduces to the identical state and appends nothing new", async () => {
    const h = makeWorkspaceHarness();
    await h.play(
      ["append", CREATED],
      [
        "append",
        {
          type: "events.iterate.com/workspace/configured",
          payload: {
            config: {
              mounts: {
                "/docs": { policy: "read-only", repoPath: "/repos/docs" },
                "/iterate": { policy: "commit-to-main" },
              },
            },
          },
        },
        {
          type: "events.iterate.com/workspace/configured",
          payload: { config: { mounts: { "/docs": null } } },
        },
      ],
      // A malformed raw event in the history, so the replay also re-runs the
      // runner's skip-diagnostic lane (its idempotency key must dedupe).
      () =>
        h.stream.append({
          type: "events.iterate.com/workspace/configured",
          payload: {
            config: { mounts: { "/bad/": { policy: "read-only", repoPath: "/repos/x" } } },
          },
        }),
    );
    const committedOffsets = h.events().map((row) => row.offset);

    const replay = makeWorkspaceHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(WorkspaceProcessorContract),
    });
    await replay.settle(); // replays the whole stream from offset zero

    expect(replay.state()).toEqual(h.state());
    // Determinism: the replayed skip diagnostic deduped on its idempotency
    // key — the stream is byte-identical after the replay.
    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
  });
});

// The workspace DO's registry wiring, minus the uninstantiable DurableObject
// shell: REAL registry + REAL runner over an in-memory stream, with the reads
// and facade built exactly as the DO builds them — pins configure()'s
// read-your-writes path (catchUp + runner-backed reads).
describe("registry + runner drive (the workspace DO's wiring)", () => {
  function fakeDurableObjectState(): DurableObjectState {
    const kv = new Map<string, unknown>();
    const alarm: { at: number | null } = { at: null };
    return {
      storage: {
        kv: {
          get: (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
          put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
          delete: (key: string) => kv.delete(key),
        },
        getAlarm: async () => alarm.at,
        setAlarm: async (at: number | Date) => {
          alarm.at = typeof at === "number" ? at : at.getTime();
        },
        deleteAlarm: async () => {
          alarm.at = null;
        },
      },
      waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
    } as unknown as DurableObjectState;
  }

  test("create-then-configure is read-your-writes through catchUp + runner-backed reads", async () => {
    const stream = new MemoryStream(WORKSPACE_PATH);
    const registry = createStreamProcessorRegistry(fakeDurableObjectState(), {
      stream,
      path: WORKSPACE_PATH,
      projectId: "prj_example",
      version: "v-test",
    });
    const workspaceProcessor = registry.register(
      new WorkspaceProcessor({ stream, path: WORKSPACE_PATH, projectId: "prj_example" }),
    );
    const reads = registry.reads(workspaceProcessor);
    const facade = new StreamProcessorRpcTarget(reads, {
      catchUpBeforeSnapshot: () => registry.catchUp(WorkspaceProcessorContract.slug),
    });

    await stream.append({
      type: "events.iterate.com/workspace/created",
      payload: {},
    });
    await expect(facade.snapshot()).resolves.toMatchObject({
      offset: 1,
      state: { config: { mounts: {} } },
    });

    await stream.append({
      type: "events.iterate.com/workspace/configured",
      payload: { config: { mounts: { "/iterate": iterateOverlay } } },
    });
    await expect(facade.snapshot()).resolves.toMatchObject({
      offset: 2,
      state: { config: { mounts: { "/iterate": iterateOverlay } } },
    });
    await expect(reads.waitUntilEvent({ offset: 2, timeoutMs: 1_000 })).resolves.toBeUndefined();
  });
});
