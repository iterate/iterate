import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "../streams/stream-processor-registry.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import { CapabilityHostProcessor } from "./capability-host-processor-implementation.ts";

const HOME = "/agents/test";
const SLUG = CapabilityHostProcessorContract.slug;

const T = {
  created: "events.iterate.com/capability-host/created",
  requested: "events.iterate.com/capability-host/script-run-requested",
  started: "events.iterate.com/capability-host/script-run-started",
  completed: "events.iterate.com/capability-host/script-run-settled",
} as const;

function capabilityHostStream(): MemoryStream {
  const stream = new MemoryStream(HOME);
  stream.events.push({
    type: T.created,
    idempotencyKey: `capability-host/created:test:${stream.path}`,
    payload: { config: { ancestorPath: "/" } },
    createdAt: new Date().toISOString(),
    offset: 1,
    path: stream.path,
  });
  return stream;
}

function makeHarness() {
  const clock = { now: Date.parse("2026-07-14T12:00:00Z") };
  const stream = capabilityHostStream();
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
        setScriptDeadline: (executionId, expiresAt) =>
          registry.setAlarmSlice(`script-execution-deadline:${executionId}`, expiresAt),
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
    alarm,
    clock,
    kv,
    stream,
    head,
    state: () => registry.reads(processor).currentState,
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
    async advance(ms: number) {
      const target = clock.now + ms;
      while (alarm.at !== null && alarm.at <= target) {
        clock.now = Math.max(clock.now, alarm.at);
        alarm.at = null;
        await registry.handleAlarm();
        // Mirror CapabilityHostDurableObject.alarm(): the registry owns the
        // shared platform alarm, then the host performs two passes so the
        // first can append a deadline settlement and the second can fold it.
        await registry.catchUp(SLUG);
        await processor.reconcileScriptDeadlines();
        await registry.catchUp(SLUG);
        await settle();
      }
      clock.now = target;
    },
    async requestScript(input: { code: string; executionId: string; expiresAt: number }) {
      await registry.catchUp(SLUG);
      return await processor.requestScript(input);
    },
  };
  return harness;
}

describe("script execution ownership recovery", () => {
  it("ignores retired script lifecycle event names", async () => {
    const h = makeHarness();
    await h.stream.append(
      {
        type: "events.iterate.com/capability-host/script-execution-requested",
        payload: { code: "async () => 1", executionId: "retired", expiresAt: h.clock.now + 60_000 },
      },
      {
        type: "events.iterate.com/capability-host/script-execution-started",
        payload: { executionId: "retired" },
      },
    );

    await h.deliverPending();

    expect(h.state().scriptExecutions).toEqual({});
  });

  it("keeps a requested intent claimable until its durably armed deadline", async () => {
    const h = makeHarness();
    const expiresAt = h.clock.now + 60_000;
    await h.stream.append({
      type: T.requested,
      payload: { code: "async () => 1", executionId: "exec-1", expiresAt },
    });

    await h.deliverPending();

    expect(h.stream.events.some((event) => event.type === T.started)).toBe(false);
    expect(h.stream.events.some((event) => event.type === T.completed)).toBe(false);
    expect(h.state().scriptExecutions["exec-1"]).toMatchObject({ status: "requested" });
    expect(h.alarm.at).not.toBeNull();
    expect(h.alarm.at!).toBeLessThanOrEqual(expiresAt);

    await h.advance(60_000);

    expect(h.stream.events.find((event) => event.type === T.completed)?.payload).toMatchObject({
      executionId: "exec-1",
      settlement: {
        failureKind: "expired",
        executionMayHaveOccurred: false,
      },
    });
  });

  it("lets a new host incarnation claim a deterministic request that never started", async () => {
    const h = makeHarness();
    const intent = {
      code: "async () => 1",
      executionId: "exec-claim-after-crash",
      expiresAt: h.clock.now + 60_000,
    };
    await h.stream.append({ type: T.requested, payload: intent });
    await h.deliverPending();

    h.crash();
    await h.deliverPending();
    const handoff = await h.requestScript(intent);

    expect(handoff.preparation).toEqual({ status: "ready", code: intent.code });
    expect(
      h.stream.events.filter(
        (event) => event.type === T.started && event.payload?.executionId === intent.executionId,
      ),
    ).toHaveLength(1);
  });

  it("leaves a started foreground attempt open before the deadline", async () => {
    const h = makeHarness();
    await h.stream.append(
      {
        type: T.requested,
        payload: { code: "async () => 1", executionId: "exec-1", expiresAt: h.clock.now + 60_000 },
      },
      { type: T.started, payload: { executionId: "exec-1" } },
    );

    await h.deliverPending();

    expect(h.stream.events.some((event) => event.type === T.completed)).toBe(false);
    expect(h.state().scriptExecutions["exec-1"]).toMatchObject({ status: "started" });
  });

  it("settles an expired request without running it", async () => {
    const h = makeHarness();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await h.stream.append({
        type: T.requested,
        payload: { code: "async () => 1", executionId: "exec-1", expiresAt: h.clock.now - 1 },
      });

      await h.deliverPending();

      expect(h.stream.events.find((event) => event.type === T.completed)?.payload).toMatchObject({
        executionId: "exec-1",
        settlement: { failureKind: "expired", executionMayHaveOccurred: false },
      });
      expect(consoleInfo).toHaveBeenCalledWith(
        "[capability-host] recovering undriven script execution",
        {
          cancellation: "not-applicable",
          executionId: "exec-1",
          failureKind: "expired",
          phase: "before-execution",
          status: "failed",
        },
      );
      expect(consoleError).not.toHaveBeenCalledWith(
        "[capability-host] settling undriven script execution",
        expect.anything(),
      );
    } finally {
      consoleError.mockRestore();
      consoleInfo.mockRestore();
    }
  });

  it("settles a started obligation only after its absolute deadline", async () => {
    const h = makeHarness();
    await h.stream.append(
      {
        type: T.requested,
        payload: { code: "async () => 1", executionId: "exec-1", expiresAt: h.clock.now - 1 },
      },
      { type: T.started, payload: { executionId: "exec-1" } },
    );

    await h.deliverPending();

    expect(h.stream.events.find((event) => event.type === T.completed)?.payload).toMatchObject({
      executionId: "exec-1",
      settlement: { failureKind: "orphaned", executionMayHaveOccurred: true },
    });
  });

  it("does not recreate a completed obligation when the journal is replayed", async () => {
    const h = makeHarness();
    await h.stream.append(
      {
        type: T.requested,
        payload: { code: "async () => 1", executionId: "exec-1", expiresAt: h.clock.now + 60_000 },
      },
      { type: T.started, payload: { executionId: "exec-1" } },
      {
        type: T.completed,
        idempotencyKey: "capability-host/script-run-settled@exec-1",
        payload: { executionId: "exec-1", settlement: { status: "succeeded", result: 1 } },
      },
    );
    h.kv.clear();
    h.crash();

    await h.deliverPending();

    expect(h.state().scriptExecutions).toEqual({});
  });
});
