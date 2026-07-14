// Repo creation as an at-head obligation, plus eviction recovery: the repo
// processor's `onCaughtUp` reconciliation of the two durable obligations —
// creation (blocking, NEVER re-run once `repo/created` folded: the seed
// force-push would clobber user commits) and GitHub imports (background,
// safely RE-driven: the sync is an idempotent current-head fast-forward).
//
// The processor is driven the way production drives it: a REAL
// createStreamProcessorRegistry (runner + durableObjectRecovery + keepalive
// alarm) over a fake DurableObjectState, the in-memory MemoryStream journal,
// and a virtual clock — the same harness shape as
// capability-host-recovery.test.ts. `crash()` is an eviction: in-flight work
// dies; the journal, KV progress, and the durable alarm survive.

import { describe, expect, it, vi } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS } from "../streams/stream-processor-keepalive.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "../streams/stream-processor-registry.ts";
import { GITHUB_LINK } from "./github-agent-test-helpers.ts";
import { REPO_REVIVED_EVENT_TYPE, RepoProcessorContract } from "./repo-processor-contract.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";

const HOME = "/repos/config";
const PROJECT_ID = "prj_1";
const SLUG = RepoProcessorContract.slug;

const createdArtifact = {
  artifactName: "prj_1--L3JlcG9zL2NvbmZpZw",
  defaultBranch: "main",
  remote: "https://example.artifacts.cloudflare.net/git/ns/prj_1--L3JlcG9zL2NvbmZpZw.git",
};
const createRequested = {
  type: "events.iterate.com/repo/create-requested" as const,
  payload: { projectId: PROJECT_ID, path: HOME },
};

function makeHarness() {
  const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
  const stream = new MemoryStream(HOME);
  stream.now = () => clock.now;

  const kv = new Map<string, unknown>();
  const alarm: { at: number | null } = { at: null };
  let pending: Promise<unknown>[] = [];
  const ctx = {
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
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise.catch(() => undefined)),
  } as unknown as DurableObjectState;

  /** Per-incarnation vendor bodies; tests reassign `impl` across crashes. The
   * defaults throw, so "must not run in this scenario" is the resting state. */
  const create: { impl: (input: unknown) => Promise<typeof createdArtifact> } = {
    impl: () => {
      throw new Error("must not create in this scenario");
    },
  };
  const sync: { impl: (input: unknown) => Promise<{ commitOid: string }> } = {
    impl: () => {
      throw new Error("must not sync in this scenario");
    },
  };

  let registry!: StreamProcessorRegistry;
  let processor!: RepoProcessor;
  const boot = () => {
    registry = createStreamProcessorRegistry(ctx, {
      stream,
      path: HOME,
      projectId: PROJECT_ID,
      version: "v-test",
      now: () => clock.now,
    });
    processor = registry.register(
      new RepoProcessor({
        stream,
        path: HOME,
        projectId: PROJECT_ID,
        createRepoArtifact: (input) => create.impl(input),
        syncFromGithubPush: (input) => sync.impl(input),
        taskChangesForArtifactPush: async () => [],
      }),
      { recovery: { revivedEventType: REPO_REVIVED_EVENT_TYPE } },
    );
  };
  boot();

  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  const head = () => stream.events.at(-1)?.offset ?? 0;

  const harness = {
    clock,
    stream,
    kv,
    alarm,
    create,
    sync,
    settle,
    head,
    get registry() {
      return registry;
    },
    /** The runner's committed fold — the read the DO's registry serves. */
    state: () => registry.reads(processor).currentState,
    /** Evict the incarnation: registry, runner, and in-flight vendor bodies
     * die; the journal, KV progress, and the durable alarm survive. */
    crash() {
      pending = [];
      boot();
    },
    async wake() {
      return await registry.wakeStreamSubscriber({
        stream: { projectId: PROJECT_ID, path: HOME, streamMaxOffset: head() },
        subscriptionKey: "wake:repo",
        processorSlug: SLUG,
      });
    },
    /** Wake and push everything past the acknowledged cursor as one frame —
     * the transport's job, minimally. */
    async deliverPending() {
      const woken = await harness.wake();
      const events = stream.events.filter((event) => event.offset > woken.checkpointOffset);
      if (events.length > 0) {
        await woken.sink({
          projectId: PROJECT_ID,
          path: HOME,
          events,
          streamMaxOffset: head(),
          state: null,
        });
      }
      await settle();
      return woken;
    },
    /** Advance virtual time, firing the durable alarm through the REAL
     * handleAlarm path whenever it comes due within the window. */
    async advance(ms: number) {
      const target = clock.now + ms;
      while (alarm.at !== null && alarm.at <= target) {
        clock.now = Math.max(clock.now, alarm.at);
        alarm.at = null; // the platform consumes the alarm by firing it
        await registry.handleAlarm();
        await settle();
      }
      clock.now = target;
    },
  };
  return harness;
}

describe("RepoProcessor create lane (creation as an at-head obligation)", () => {
  it("creates the artifact once at head and journals repo/created", async () => {
    const h = makeHarness();
    const createCalls: unknown[] = [];
    h.create.impl = async (input) => {
      createCalls.push(input);
      return createdArtifact;
    };

    await h.stream.append(createRequested);
    await h.deliverPending();

    expect(createCalls).toEqual([{ path: HOME, projectId: PROJECT_ID }]);
    const created = h.stream.events.filter(
      (event) => event.type === "events.iterate.com/repo/created",
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      idempotencyKey: "repo/created",
      payload: { ...createdArtifact, path: HOME, projectId: PROJECT_ID },
    });

    await h.deliverPending();
    expect(h.state()).toMatchObject({ createRequested: true, created: true });
    expect(createCalls).toHaveLength(1);
  });

  it("defers creation while the fold is behind the head, then creates once caught up", async () => {
    const h = makeHarness();
    const createCalls: unknown[] = [];
    h.create.impl = async (input) => {
      createCalls.push(input);
      return createdArtifact;
    };
    const [requested] = await h.stream.append(createRequested);

    // The production wake lane is consumes-filtered but stamped with the RAW
    // stream head, so a frame can deliver create-requested while naming a
    // head PAST it — the mid-catch-up shape. No at-head pulse fires, so the
    // creation obligation must stay untouched.
    const woken = await h.wake();
    await woken.sink({
      projectId: PROJECT_ID,
      path: HOME,
      events: [requested!],
      streamMaxOffset: 2,
      state: null,
    });
    await h.settle();
    expect(createCalls).toHaveLength(0);

    // The head-reaching delivery lands; the at-head pulse creates exactly once.
    await h.stream.append({
      type: "events.iterate.com/repo/github-link-configured",
      payload: GITHUB_LINK,
    });
    await h.deliverPending();
    expect(createCalls).toHaveLength(1);
  });

  it("refold: a journal that already contains repo/created never re-creates", async () => {
    const h = makeHarness();
    const createCalls: unknown[] = [];
    h.create.impl = async (input) => {
      createCalls.push(input);
      return createdArtifact;
    };

    await h.stream.append(createRequested);
    await h.deliverPending();
    await h.deliverPending();
    expect(createCalls).toHaveLength(1);
    const journalBeforeRefold = h.stream.events.length;
    const stateBeforeRefold = h.state();

    // A fresh incarnation replaying the WHOLE journal (durable progress
    // erased): the refold replays `create-requested` with event-time state in
    // which `created` is still false, but the at-head fold has absorbed the
    // journaled `repo/created` fact — createRepoArtifact, whose seeding
    // force-pushes the seed commit over user commits, must provably not run.
    h.kv.clear();
    h.crash();
    h.create.impl = () => {
      throw new Error("refold must not re-create an existing repo");
    };
    await h.deliverPending();

    expect(h.stream.events).toHaveLength(journalBeforeRefold);
    expect(h.state()).toEqual(stateBeforeRefold);
  });
});

describe("eviction recovery end to end", () => {
  it("died owing the creation → keepalive alarm → revived fact → its delivery reaches head → onCaughtUp completes the creation", async () => {
    const h = makeHarness();
    // Incarnation 1 HANGS mid-create: the at-head frame is blocked inside
    // onCaughtUp's creation obligation, the attempt rides the keepalive, the
    // revival alarm is armed. The frame never resolves — do not await it.
    h.create.impl = () => new Promise<never>(() => {});
    await h.stream.append(createRequested);
    const woken = await h.wake();
    void Promise.resolve(
      woken.sink({
        projectId: PROJECT_ID,
        path: HOME,
        events: h.stream.events.filter((event) => event.offset > woken.checkpointOffset),
        streamMaxOffset: h.head(),
        state: null,
      }),
    ).catch(() => undefined);
    await h.settle();
    expect(h.alarm.at).not.toBeNull();
    expect(h.stream.events.some((event) => event.type === "events.iterate.com/repo/created")).toBe(
      false,
    );

    h.crash(); // the in-flight creation dies; journal, KV, and the alarm survive
    const createCalls: unknown[] = [];
    h.create.impl = async (input) => {
      createCalls.push(input);
      return createdArtifact;
    };
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);

    // durableObjectRecovery's revival pass journaled the processor-scoped
    // fact — the ONLY thing that creates a delivery turn for the wedged frame.
    const revived = h.stream.events.filter((event) => event.type === REPO_REVIVED_EVENT_TYPE);
    expect(revived).toHaveLength(1);
    expect(revived[0]!.payload).toMatchObject({
      processorSlug: SLUG,
      revivals: 1,
      version: "v-test",
    });

    // Its ordinary delivery drives the runner to head; onCaughtUp finds the
    // still-open creation obligation in the fold and completes it — exactly
    // once, under the stable obligation key.
    await h.deliverPending();
    const created = h.stream.events.filter(
      (event) => event.type === "events.iterate.com/repo/created",
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.idempotencyKey).toBe("repo/created");
    expect(createCalls).toEqual([{ path: HOME, projectId: PROJECT_ID }]);

    await h.deliverPending();
    expect(h.state()).toMatchObject({ createRequested: true, created: true });
  });

  it("re-drives a GitHub import owed at zero lag: revived fact → onCaughtUp re-runs the idempotent sync", async () => {
    const h = makeHarness();
    // Incarnation 1 starts the import and HANGS mid-sync: the started fact is
    // journaled, the attempt rides the keepalive, the revival alarm is armed.
    h.sync.impl = () => new Promise<never>(() => {});
    await h.stream.append({
      type: "events.iterate.com/repo/github-import-requested",
      payload: {
        branch: "main",
        requestId: "/repos/config:42",
        requestedCommitOid: "requested-head",
      },
    });
    await h.deliverPending();
    await vi.waitFor(() => {
      expect(
        h.stream.events.some(
          (event) => event.type === "events.iterate.com/repo/github-import-started",
        ),
      ).toBe(true);
    });
    // Fold the started fact too, so the acknowledged cursor sits AT HEAD:
    // the zero-lag wedge — after the eviction, no ordinary redelivery exists
    // to hand this processor a recovery turn.
    await h.deliverPending();
    expect((await h.wake()).checkpointOffset).toBe(h.head());
    expect(h.alarm.at).not.toBeNull();

    h.crash(); // the in-flight sync dies; journal, KV, and the alarm survive
    const syncCalls: unknown[] = [];
    h.sync.impl = async (input) => {
      syncCalls.push(input);
      return { commitOid: "current-github-head" };
    };
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);

    expect(h.stream.events.filter((event) => event.type === REPO_REVIVED_EVENT_TYPE)).toHaveLength(
      1,
    );

    // The revived delivery drives the runner to head; onCaughtUp finds the
    // open import obligation and — unlike scripts — RE-drives it: the sync is
    // an idempotent current-head fast-forward.
    await h.deliverPending();
    await vi.waitFor(() => {
      const completed = h.stream.events.find(
        (event) => event.type === "events.iterate.com/repo/github-import-completed",
      );
      expect(completed?.payload).toMatchObject({
        commitOid: "current-github-head",
        requestId: "/repos/config:42",
      });
    });
    expect(syncCalls).toEqual([{ afterCommitOid: "requested-head", branch: "main" }]);
  });
});
