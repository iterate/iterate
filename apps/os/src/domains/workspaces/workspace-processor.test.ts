// The workspace processor's executable spec on the generic step harness
// (iterate/processors/testing): the REAL StreamProcessorRunner over the
// shared MemoryStream (production idempotency and parse-skip semantics),
// eviction-faithful crash(). Scenarios are ordered steps — typed appends plus
// function steps for the raw (contract-bypassing) appends the malformed-event
// suite needs. The registry-level suite at the bottom keeps its inline
// fake-DurableObjectState harness: it pins the workspace DO's WIRING
// (registry + runner-backed reads), not the processor's reduce.

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

const configMount = { policy: "commit-to-main", repoPath: "/repos/config" } as const;
const iterateMount = { policy: "read-only", repoPath: "/repos/iterate" } as const;

const CREATED = {
  type: "events.iterate.com/workspace/created",
  payload: { config: { mounts: { "/": configMount, "/iterate": iterateMount } } },
} satisfies ConsumedInput<WorkspaceProcessorContract>;

function makeWorkspaceHarness(substrate?: HarnessSubstrate) {
  return makeProcessorHarness<WorkspaceProcessorContract>({
    createProcessor: (deps) => new WorkspaceProcessor(deps),
    path: WORKSPACE_PATH,
    ...(substrate === undefined ? {} : { substrate }),
  });
}

describe("WorkspaceProcessor reduce", () => {
  test("creation merges supplied mounts over the default root mount", async () => {
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
      birthCertificate: { config: { mounts: { "/": configMount } } },
      config: {
        mounts: {
          "/": configMount,
          "/cfg": { policy: "read-only", repoPath: "/repos/config" },
        },
      },
    });
  });

  test("created reduces the birth certificate and its config", async () => {
    const h = makeWorkspaceHarness();
    await h.play(["append", CREATED]);

    expect(h.state()).toMatchObject({
      birthCertificate: { config: { mounts: { "/": configMount, "/iterate": iterateMount } } },
      config: { mounts: { "/": configMount, "/iterate": iterateMount } },
    });
    // Pure reducer: the stream holds exactly what the test appended — the
    // processor made no appends of its own.
    expect(h.events()).toHaveLength(1);
  });

  test("a configured patch deep-merges per mount: partial edit, add, and null-unmount — across an eviction", async () => {
    const h = makeWorkspaceHarness();
    await h.play(
      ["append", CREATED],
      // Eviction between the certificate and the patch: the successor
      // incarnation resumes from committed progress and reduces on.
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
                // Unknown key: adds a mount.
                "/docs": { policy: "read-only", repoPath: "/repos/docs" },
                // null: unmounts.
                "/": null,
              },
            },
          },
        },
      ],
    );

    expect(h.state()).toMatchObject({
      // The certificate preserves what the workspace was born with…
      birthCertificate: { config: { mounts: { "/": configMount, "/iterate": iterateMount } } },
      // …while the live table carries the merged result.
      config: {
        mounts: {
          "/docs": { policy: "read-only", repoPath: "/repos/docs" },
          "/iterate": { policy: "commit-to-main", repoPath: "/repos/iterate" },
        },
      },
    });
    expect(h.state().config.mounts).not.toHaveProperty("/");
    expect(h.events()).toHaveLength(2);
  });

  test("a SECOND created event is skipped — the first certificate wins, the reduce never wedges", async () => {
    const h = makeWorkspaceHarness();
    await h.play([
      "append",
      CREATED,
      // Raw append under a different idempotency key: schema-valid, must
      // reduce as a no-op rather than throwing the cursor into a wedge.
      {
        type: "events.iterate.com/workspace/created",
        payload: { config: { mounts: { "/other": iterateMount } } },
      },
    ]);

    expect(h.state()).toMatchObject({
      birthCertificate: { config: { mounts: { "/": configMount, "/iterate": iterateMount } } },
      config: { mounts: { "/": configMount, "/iterate": iterateMount } },
    });
    expect(h.state().config.mounts).not.toHaveProperty("/other");
  });

  test("a patch adding an INCOMPLETE mount reduces without wedging — the entry is dropped", async () => {
    const h = makeWorkspaceHarness();
    await h.play([
      "append",
      CREATED,
      // Schema-valid (partial values are legal patch entries) but there is
      // no existing "/new" mount to merge into — a raw append can commit
      // this, and the reduce must drop the entry, not throw.
      {
        type: "events.iterate.com/workspace/configured",
        payload: { config: { mounts: { "/new": { policy: "read-only" } } } },
      },
      // The reduce keeps advancing past it.
      {
        type: "events.iterate.com/workspace/configured",
        payload: {
          config: { mounts: { "/docs": { policy: "read-only", repoPath: "/repos/docs" } } },
        },
      },
    ]);

    expect(h.state().config.mounts).toMatchObject({
      "/": configMount,
      "/docs": { policy: "read-only", repoPath: "/repos/docs" },
    });
    expect(h.state().config.mounts).not.toHaveProperty("/new");
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

    expect(h.state().config.mounts).toEqual({ "/": configMount, "/iterate": iterateMount });
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
          payload: { config: { mounts: { "/iterate": { policy: "commit-to-main" }, "/": null } } },
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
      progress: makeMemoryProgressStore(),
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
      payload: { config: { mounts: { "/": configMount } } },
    });
    await expect(facade.snapshot()).resolves.toMatchObject({
      offset: 1,
      state: { config: { mounts: { "/": configMount } } },
    });

    await stream.append({
      type: "events.iterate.com/workspace/configured",
      payload: { config: { mounts: { "/iterate": iterateMount } } },
    });
    await expect(facade.snapshot()).resolves.toMatchObject({
      offset: 2,
      state: { config: { mounts: { "/": configMount, "/iterate": iterateMount } } },
    });
    await expect(reads.waitUntilEvent({ offset: 2, timeoutMs: 1_000 })).resolves.toBeUndefined();
  });
});
