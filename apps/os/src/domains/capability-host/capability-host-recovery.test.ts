// Script-execution recovery: the capability-host processor's at-head
// reconciliation (`onCaughtUp`) of journaled script obligations against this
// incarnation's live executions — the same doctrine as the LLM providers, with
// the script-specific policy that a `started` obligation is settled as failure
// and NEVER re-run (scripts may have half-executed non-idempotent effects).
//
// The processor is driven the way production drives it: a REAL
// createStreamProcessorRegistry (runner + durableObjectRecovery + keepalive
// alarm) over a fake DurableObjectState, the in-memory MemoryStream journal,
// and a virtual clock — the same harness shape as
// stream-processor-registry.test.ts. `crash()` is an eviction: in-flight work
// dies; the journal, KV progress, and the durable alarm survive.

import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import { KEEPALIVE_ALARM_LEAD_MS } from "../streams/stream-processor-keepalive.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "../streams/stream-processor-registry.ts";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "../streams/core-processor-contract.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import { CapabilityHostProcessor } from "./capability-host-processor-implementation.ts";

const HOME = "/agents/test";
const SLUG = CapabilityHostProcessorContract.slug;

const T = {
  created: "events.iterate.com/capability-host/created",
  requested: "events.iterate.com/capability-host/script-run-requested",
  started: "events.iterate.com/capability-host/script-run-started",
  completed: "events.iterate.com/capability-host/script-run-settled",
  revived: STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
} as const;

function capabilityHostStream(path = "/"): MemoryStream {
  const stream = new MemoryStream(path);
  stream.events.push({
    type: T.created,
    idempotencyKey: `capability-host/created:test:${stream.path}`,
    payload: { config: {} },
    createdAt: new Date().toISOString(),
    offset: 1,
    path: stream.path,
  });
  return stream;
}

function makeHarness() {
  const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
  const stream = capabilityHostStream(HOME);
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

  /** Per-incarnation script body; tests reassign `impl` across crashes. The
   * default throws, so "must not run in this scenario" is the resting state. */
  const run: { impl: (code: string) => Promise<unknown> } = {
    impl: () => {
      throw new Error("must not run in this scenario");
    },
  };

  let registry!: StreamProcessorRegistry;
  let processor!: CapabilityHostProcessor;
  const boot = () => {
    registry = createStreamProcessorRegistry(ctx, {
      stream,
      path: HOME,
      projectId: null,
      version: "v-test",
      now: () => clock.now,
    });
    processor = registry.register(
      new CapabilityHostProcessor({
        stream,
        path: HOME,
        projectId: null,
        itx: {} as Project,
        now: () => clock.now,
        scriptExecutionEntrypoint: { run: (code) => run.impl(code) },
        // Runner-backed reads, exactly as the hosting DO wires
        // registry.reads(...) (lazy closures: reads() needs the registered
        // processor, which this constructor call is still producing).
        reads: {
          snapshot: () => registry.reads(processor).snapshot(),
          waitUntilEvent: (input) => registry.reads(processor).waitUntilEvent(input),
        },
      }),
      { recovery: true },
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
    run,
    settle,
    head,
    get registry() {
      return registry;
    },
    /** The runner's committed fold — the read the DO's registry serves. */
    state: () => registry.reads(processor).currentState,
    /** Evict the incarnation: registry, runner, and in-flight script bodies
     * die; the journal, KV progress, and the durable alarm survive. */
    crash() {
      pending = [];
      boot();
    },
    async wake() {
      return await registry.wakeStreamSubscriber({
        stream: { projectId: null, path: HOME, streamMaxOffset: head() },
        subscriptionKey: "wake:capability-host",
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
          projectId: null,
          path: HOME,
          events,
          scannedAfterOffset: woken.checkpointOffset,
          scannedThroughOffset: head(),
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

describe("script execution reconciliation", () => {
  it("does not refold retired lifecycle events into current script obligations", async () => {
    const h = makeHarness();
    await h.stream.append(
      {
        type: "events.iterate.com/capability-host/script-execution-requested",
        payload: {
          code: "async () => 'retired'",
          executionId: "retired-exec",
          expiresAt: h.clock.now + 60_000,
        },
      },
      {
        type: "events.iterate.com/capability-host/script-execution-started",
        payload: { executionId: "retired-exec" },
      },
      {
        type: "events.iterate.com/capability-host/script-execution-completed",
        idempotencyKey: "capability-host/script-execution-completed@retired-exec",
        payload: { executionId: "retired-exec", result: "retired" },
      },
    );

    await h.deliverPending();

    expect(h.state().scriptExecutions).toEqual({});
    expect(
      h.stream.events.filter((event) => event.type === T.started || event.type === T.completed),
    ).toEqual([]);
  });

  it("runs a fresh request: started evidence lands before the body, completion after", async () => {
    const h = makeHarness();
    const ran: string[] = [];
    h.run.impl = async (code) => {
      // The started fact must already be durable when the body runs.
      expect(h.stream.events.some((event) => event.type === T.started)).toBe(true);
      ran.push(code);
      return { status: "succeeded" as const, result: { ok: true } };
    };
    await h.stream.append({
      type: T.requested,
      payload: { code: "async () => 1", executionId: "exec-1", expiresAt: h.clock.now + 60_000 },
    });
    await h.deliverPending();

    await vi.waitFor(() => {
      const completed = h.stream.events.find((event) => event.type === T.completed);
      expect(completed?.idempotencyKey).toBe("capability-host/script-run-settled@exec-1");
      expect(completed?.payload).toMatchObject({
        executionId: "exec-1",
        settlement: { status: "succeeded", result: { ok: true } },
      });
    });
    expect(ran).toEqual(["async () => 1"]);
  });

  it("settles an orphaned execution (started, incarnation died) without re-running it", async () => {
    const h = makeHarness();
    // The dead incarnation's evidence, written before it was evicted.
    await h.stream.append(
      {
        type: T.requested,
        payload: { code: "async () => 1", executionId: "exec-1", expiresAt: h.clock.now + 60_000 },
      },
      { type: T.started, payload: { executionId: "exec-1" } },
    );
    await h.deliverPending(); // run.impl throws if invoked

    await vi.waitFor(() => {
      const completed = h.stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "exec-1",
        settlement: {
          status: "failed",
          error: expect.stringContaining("orphaned"),
          failureKind: "orphaned",
        },
      });
    });
  });

  it("recovers a request whose incarnation died BEFORE any attempt started (provably never ran → runs it)", async () => {
    const h = makeHarness();
    // The dead incarnation appended the request but never a started fact.
    await h.stream.append({
      type: T.requested,
      payload: { code: "async () => 2", executionId: "exec-2", expiresAt: h.clock.now + 60_000 },
    });
    const ran: string[] = [];
    h.run.impl = async (code) => {
      ran.push(code);
      return { status: "succeeded" as const, result: 42 };
    };
    // Recovery reads the head FOLD, not any particular batch: the caught-up
    // pass after this delivery finds the undriven obligation and runs it.
    await h.deliverPending();
    await vi.waitFor(() => {
      expect(h.stream.events.some((event) => event.type === T.completed)).toBe(true);
    });
    expect(ran).toEqual(["async () => 2"]);
  });

  it("a failed started-append leaves the obligation requested (no body run, no completion) and retries", async () => {
    const h = makeHarness();
    h.stream.failAppendsOfType = T.started;
    const ran: string[] = [];
    h.run.impl = async (code) => {
      ran.push(code);
      return { status: "succeeded" as const, result: "ok" };
    };
    await h.stream.append({
      type: T.requested,
      payload: { code: "async () => 5", executionId: "exec-5", expiresAt: h.clock.now + 60_000 },
    });
    await h.deliverPending();
    // Give the failed attempt a beat: nothing may have run or settled — the
    // evidence rule ("no started fact ⇒ never ran") must stay true.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual([]);
    expect(h.stream.events.some((event) => event.type === T.completed)).toBe(false);
    expect(h.state().scriptExecutions["exec-5"]).toMatchObject({ status: "requested" });

    // The stream recovers; the next caught-up pass retries the whole attempt
    // from the fold. The trigger is a CONSUMED lifecycle re-check event
    // (`stream/woken` — a stream restart) reaching head: the reconcile only
    // fires when a consumed event is delivered at head, never on a fold no
    // consumed event carried it to.
    h.stream.failAppendsOfType = undefined;
    await h.stream.append({
      type: "events.iterate.com/stream/woken",
      payload: { incarnationId: "retry" },
    });
    await h.deliverPending();
    await vi.waitFor(() => {
      const completed = h.stream.events.find(
        (event) =>
          event.type === T.completed &&
          (event.payload as { executionId: string }).executionId === "exec-5",
      );
      expect(completed?.payload).toMatchObject({
        executionId: "exec-5",
        settlement: { status: "succeeded", result: "ok" },
      });
    });
    expect(ran).toEqual(["async () => 5"]);
  });

  it("settles an expired request without running it (only-settle-past-expiry)", async () => {
    const h = makeHarness();
    await h.stream.append({
      type: T.requested,
      payload: {
        code: "async () => 3",
        executionId: "exec-3",
        expiresAt: h.clock.now - 1, // the host slept past the intent's horizon
      },
    });
    await h.deliverPending(); // run.impl throws if invoked

    await vi.waitFor(() => {
      const completed = h.stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "exec-3",
        settlement: {
          status: "failed",
          error: expect.stringContaining("expired"),
          failureKind: "expired",
        },
      });
    });
  });

  it("settles and cancels a started script when its absolute deadline passes", async () => {
    const h = makeHarness();
    const run = new Promise<unknown>(() => {}) as Promise<unknown> & {
      [Symbol.dispose]: ReturnType<typeof vi.fn>;
    };
    run[Symbol.dispose] = vi.fn();
    h.run.impl = () => run;
    await h.stream.append({
      type: T.requested,
      payload: {
        code: 'async (itx) => { const sandbox = await itx.sandboxes.get("/sandboxes/iterate-live-clocks"); return sandbox.exec("pnpm typecheck", { timeout: 1200000 }); }',
        executionId: "agent-output:13980",
        // The host reserves 15s to persist the settlement, leaving this
        // worker RPC a deliberately tiny real-time window.
        expiresAt: h.clock.now + 15_020,
      },
    });

    await h.deliverPending();
    await vi.waitFor(() => {
      const completed = h.stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "agent-output:13980",
        settlement: {
          status: "failed",
          failureKind: "deadline",
          phase: "execution",
        },
      });
    });
    expect(run[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("a completion settles the obligation for good: replayed batches change nothing", async () => {
    const h = makeHarness();
    h.run.impl = async () => ({ status: "succeeded" as const, result: "done" });
    await h.stream.append({
      type: T.requested,
      payload: { code: "async () => 4", executionId: "exec-4", expiresAt: h.clock.now + 60_000 },
    });
    await h.deliverPending();
    await vi.waitFor(() => {
      expect(h.stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
    });

    // A fresh incarnation replaying the WHOLE journal (durable progress
    // erased): the fold re-creates and re-settles the obligation in order;
    // the idempotent completion append collapses at the dedup layer.
    h.kv.clear();
    h.crash();
    h.run.impl = () => {
      throw new Error("must not run in this scenario");
    };
    await h.deliverPending();
    expect(h.stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
  });
});

describe("eviction recovery end to end", () => {
  it("died owing work → keepalive alarm → revived fact → its delivery reaches head → onCaughtUp settles the orphan", async () => {
    const h = makeHarness();
    // Incarnation 1 starts the script and HANGS mid-body: the started fact is
    // journaled, the attempt rides the keepalive, the revival alarm is armed.
    h.run.impl = () => new Promise<never>(() => {});
    await h.stream.append({
      type: T.requested,
      payload: { code: "async () => 1", executionId: "exec-1", expiresAt: h.clock.now + 60_000 },
    });
    await h.deliverPending();
    await vi.waitFor(() => {
      expect(h.stream.events.some((event) => event.type === T.started)).toBe(true);
    });
    // Fold the started fact too, so the acknowledged cursor sits AT HEAD:
    // the zero-lag wedge — after the eviction, no ordinary redelivery exists
    // to hand this processor a recovery turn.
    await h.deliverPending();
    expect((await h.wake()).checkpointOffset).toBe(h.head());
    expect(h.alarm.at).not.toBeNull();

    h.crash(); // the in-flight body dies; journal, KV, and the alarm survive
    h.run.impl = () => {
      throw new Error("must not re-run an orphaned script");
    };
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);

    // durableObjectRecovery's revival pass journaled the processor-scoped
    // fact — the ONLY thing that creates a delivery turn at zero lag.
    const revived = h.stream.events.filter((event) => event.type === T.revived);
    expect(revived).toHaveLength(1);
    expect(revived[0]!.payload).toMatchObject({
      processorSlug: SLUG,
      revivals: 1,
      version: "v-test",
    });

    // Its ordinary delivery drives the runner to head; onCaughtUp compares
    // the fold's `started` obligation against the (empty) live-execution set
    // and settles it as an orphan failure — the body is never re-run.
    await h.deliverPending();
    await vi.waitFor(() => {
      const completed = h.stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "exec-1",
        settlement: {
          status: "failed",
          error: expect.stringContaining("orphaned"),
          failureKind: "orphaned",
        },
      });
    });
    expect(h.stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
  });
});
