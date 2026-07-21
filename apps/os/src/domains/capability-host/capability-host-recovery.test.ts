// Focused script-execution recovery through the shared processor harness.
// `crash()` is eviction; the durable keepalive alarm wakes the successor.

import { describe, expect, it, vi } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS, STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import type { Project } from "../../itx-api.generated.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import { CapabilityHostProcessor } from "./capability-host-processor-implementation.ts";

const HOME = "/agents/test";
const T = {
  created: "events.iterate.com/capability-host/created",
  requested: "events.iterate.com/capability-host/script-run-requested",
  started: "events.iterate.com/capability-host/script-run-started",
  completed: "events.iterate.com/capability-host/script-run-settled",
  revived: STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
} as const;

function makeHarness() {
  const run: { impl: (code: string) => Promise<unknown> } = {
    impl: () => {
      throw new Error("must not run in this scenario");
    },
  };
  const harness = makeProcessorHarness<CapabilityHostProcessorContract, CapabilityHostProcessor>({
    path: HOME,
    createProcessor: (deps) =>
      new CapabilityHostProcessor({
        ...deps,
        itx: {} as Project,
        scriptExecutionEntrypoint: { run: (code) => run.impl(code) },
        reads: deps.reads,
      }),
  });
  harness.clock.now = Date.parse("2026-07-14T12:00:00Z");
  harness.stream.events.push({
    type: T.created,
    idempotencyKey: `capability-host/created:test:${HOME}`,
    payload: { config: {} },
    createdAt: new Date(harness.clock.now).toISOString(),
    offset: 1,
    path: HOME,
  });
  return { ...harness, run };
}

describe("script execution recovery at head", () => {
  it("does not reduce retired lifecycle events into current script obligations", async () => {
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
    await h.settle();

    expect(h.state().scriptExecutions).toEqual({});
    expect(
      h.events().filter((event) => event.type === T.started || event.type === T.completed),
    ).toEqual([]);
  });

  it("a failed started append leaves the request safe to retry", async () => {
    const h = makeHarness();
    h.stream.failAppendsOfType = T.started;
    const ran: string[] = [];
    h.run.impl = async (code) => {
      ran.push(code);
      return { status: "succeeded" as const, result: "ok" };
    };
    await h.append({
      type: T.requested,
      payload: { code: "async () => 5", executionId: "exec-5", expiresAt: h.clock.now + 60_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual([]);
    expect(h.events(T.completed)).toHaveLength(0);
    expect(h.state().scriptExecutions["exec-5"]).toMatchObject({ status: "requested" });

    h.stream.failAppendsOfType = undefined;
    await h.stream.append({
      type: "events.iterate.com/stream/woken",
      payload: { incarnationId: "retry" },
    });
    await h.settle();

    expect(h.events(T.completed)).toMatchObject([
      {
        payload: {
          executionId: "exec-5",
          settlement: { status: "succeeded", result: "ok" },
        },
      },
    ]);
    expect(ran).toEqual(["async () => 5"]);
  });

  it("settles and cancels a started script when its absolute deadline passes", async () => {
    const h = makeHarness();
    const run = new Promise<unknown>(() => {}) as Promise<unknown> & {
      [Symbol.dispose]: ReturnType<typeof vi.fn>;
    };
    run[Symbol.dispose] = vi.fn();
    h.run.impl = () => run;
    await h.append({
      type: T.requested,
      payload: {
        code: 'async (itx) => itx.sandboxes.get("/sandboxes/test")',
        executionId: "agent-output:13980",
        expiresAt: h.clock.now + 15_020,
      },
    });

    await vi.waitFor(() => {
      expect(h.events(T.completed)[0]?.payload).toMatchObject({
        executionId: "agent-output:13980",
        settlement: { status: "failed", failureKind: "deadline", phase: "execution" },
      });
    });
    expect(run[Symbol.dispose]).toHaveBeenCalledOnce();
  });
});

describe("eviction recovery end to end", () => {
  it("revives at zero lag and settles the orphan without re-running it", async () => {
    const h = makeHarness();
    h.run.impl = () => new Promise<never>(() => {});
    await h.append({
      type: T.requested,
      payload: { code: "async () => 1", executionId: "exec-1", expiresAt: h.clock.now + 60_000 },
    });
    await vi.waitFor(() => expect(h.events(T.started)).toHaveLength(1));
    expect((await h.runner().snapshot()).offset).toBe(h.events().at(-1)!.offset);

    h.crash();
    await h.settle();
    h.run.impl = () => {
      throw new Error("must not re-run an orphaned script");
    };
    await h.advanceTime(KEEPALIVE_ALARM_LEAD_MS + 1);

    expect(h.events(T.revived)).toMatchObject([
      {
        payload: {
          processorSlug: CapabilityHostProcessorContract.slug,
          revivals: 1,
          version: "test-harness",
        },
      },
    ]);
    expect(h.events(T.completed)).toMatchObject([
      {
        payload: {
          executionId: "exec-1",
          settlement: { status: "failed", failureKind: "orphaned" },
        },
      },
    ]);
  });
});
