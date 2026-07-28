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
        scriptExecutionExecutor: {
          start: async (code, options) => {
            // Production returns from this handoff immediately and lets the
            // independently-lived alarm executor append its own settlement.
            const work = Promise.resolve()
              .then(() => run.impl(code))
              .then((settlement) =>
                deps.stream.appendIfStreamId({
                  streamId: options.streamId,
                  events: [
                    {
                      type: T.completed,
                      idempotencyKey: `capability-host/script-run-settled@${options.streamContext.executionId}`,
                      payload: {
                        executionId: options.streamContext.executionId,
                        settlement: settlement as Record<string, unknown>,
                      },
                    },
                  ],
                }),
              );
            void work.catch(() => undefined);
          },
        },
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
    await vi.waitFor(async () => {
      await h.settle();
      expect(h.events(T.completed)).toHaveLength(1);
    });

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

  it("keeps a started obligation open while the independent executor is still within deadline", async () => {
    const h = makeHarness();
    h.run.impl = () => new Promise<never>(() => {});
    await h.append({
      type: T.requested,
      payload: {
        code: 'async (itx) => itx.sandboxes.get("/sandboxes/test")',
        executionId: "agent-output:13980",
        expiresAt: h.clock.now + 60_000,
      },
    });

    await vi.waitFor(() => expect(h.events(T.started)).toHaveLength(1));
    expect(h.events(T.completed)).toHaveLength(0);
    expect(h.state().scriptExecutions["agent-output:13980"]).toMatchObject({
      status: "started",
    });
  });
});

describe("eviction recovery end to end", () => {
  it("revives at zero lag, resumes the settlement watch, and never re-runs the script", async () => {
    const h = makeHarness();
    let finish!: (value: unknown) => void;
    h.run.impl = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
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
    expect(h.events(T.completed)).toHaveLength(0);
    expect(h.state().scriptExecutions["exec-1"]).toMatchObject({ status: "started" });

    finish({ status: "succeeded", result: "survived" });
    await vi.waitFor(async () => {
      await h.settle();
      expect(h.events(T.completed)).toHaveLength(1);
    });
    expect(h.events(T.completed)).toMatchObject([
      {
        payload: {
          executionId: "exec-1",
          settlement: { status: "succeeded", result: "survived" },
        },
      },
    ]);
  });
});
