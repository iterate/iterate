// Script-execution recovery: the capability-host processor's end-of-batch
// reconciliation of journaled script obligations against this incarnation's
// live executions — the same doctrine as the LLM providers, with the
// script-specific policy that a `started` obligation is settled as failure
// and NEVER re-run (scripts may have half-executed non-idempotent effects).

import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  CapabilityHostProcessor,
  SCRIPT_COMPLETION_OBSERVATION_GRACE_MS,
  SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
} from "./capability-host-processor-implementation.ts";
import {
  DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
  type ScriptExecutionSettlement,
} from "./capability-host-processor-contract.ts";

const T = {
  requested: "events.iterate.com/capability-host/script-execution-requested",
  started: "events.iterate.com/capability-host/script-execution-started",
  completed: "events.iterate.com/capability-host/script-execution-completed",
} as const;

function requestPayload(executionId: string, code: string) {
  return {
    code,
    executionId,
    expiresAt: Date.now() + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
  };
}

function makeProcessor(options: {
  stream: MemoryStream;
  now?: () => number;
  run?: (code: string) => Promise<unknown>;
}) {
  return new CapabilityHostProcessor({
    stream: options.stream,
    itx: {} as Project,
    path: "/",
    projectId: null,
    now: options.now,
    scriptExecutionEntrypoint: {
      run:
        options.run ??
        (() => {
          throw new Error("must not run in this scenario");
        }),
    },
  });
}

describe("script execution reconciliation", () => {
  it("bounds the public runScript wait and stamps the same absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const stream = new MemoryStream();
      const processor = makeProcessor({ stream, now: Date.now });

      const running = processor.runScript("async () => 1");
      await vi.waitFor(() => expect(stream.events).toHaveLength(1));
      expect(stream.events[0]?.payload).toMatchObject({
        code: "async () => 1",
        expiresAt: now + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
      });

      const rejected = expect(running).rejects.toThrow(
        /did not settle before its absolute deadline/,
      );
      await vi.advanceTimersByTimeAsync(
        DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS + SCRIPT_COMPLETION_OBSERVATION_GRACE_MS,
      );
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a half-open initial request append at the same absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const stream = new MemoryStream();
      const realAppend = stream.append.bind(stream);
      stream.append = async (...inputs) => {
        if (inputs.some((input) => input.type === T.requested)) {
          return new Promise<never>(() => {});
        }
        return realAppend(...inputs);
      };
      const processor = makeProcessor({ stream, now: Date.now });

      const running = processor.runScript("async () => 1");
      const rejected = expect(running).rejects.toThrow(
        /Timed out while attempting to record the request for script execution/,
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS);

      await rejected;
      expect(stream.events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a fresh request: started evidence lands before the body, completion after", async () => {
    const stream = new MemoryStream();
    const ran: string[] = [];
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        // The started fact must already be durable when the body runs.
        expect(stream.events.some((event) => event.type === T.started)).toBe(true);
        ran.push(code);
        return { status: "succeeded", result: { ok: true } };
      },
    });
    const [requested] = await stream.append({
      type: T.requested,
      payload: requestPayload("exec-1", "async () => 1"),
    });
    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: requested!.offset });

    await vi.waitFor(() => {
      const completed = stream.events.find((event) => event.type === T.completed);
      expect(completed?.idempotencyKey).toBe("capability-host/script-execution-completed@exec-1");
      expect(completed?.payload).toMatchObject({
        executionId: "exec-1",
        settlement: { status: "succeeded", result: { ok: true } },
      });
    });
    expect(ran).toEqual(["async () => 1"]);
  });

  it("journals a synchronous worker invocation failure after the started evidence", async () => {
    const stream = new MemoryStream();
    const processor = makeProcessor({
      stream,
      run: () => {
        throw new Error("worker binding unavailable");
      },
    });
    const [requested] = await stream.append({
      type: T.requested,
      payload: requestPayload("exec-sync-failure", "async () => 1"),
    });

    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: requested!.offset });

    await vi.waitFor(() => {
      expect(stream.events.find((event) => event.type === T.completed)?.payload).toMatchObject({
        executionId: "exec-sync-failure",
        settlement: {
          status: "failed",
          error: "worker binding unavailable",
          failureKind: "runtime",
          phase: "execution",
          executionMayHaveOccurred: true,
          cancellation: "external-work-may-continue",
        },
      });
    });
    expect(stream.events.some((event) => event.type === T.started)).toBe(true);
  });

  it("classifies a malformed worker settlement as a durable failure", async () => {
    const stream = new MemoryStream();
    const processor = makeProcessor({
      stream,
      run: async () => ({ status: "succeeded", extra: "not part of the contract" }),
    });
    const [requested] = await stream.append({
      type: T.requested,
      payload: requestPayload("exec-invalid-settlement", "async () => 1"),
    });

    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: requested!.offset });

    await vi.waitFor(() => {
      expect(stream.events.find((event) => event.type === T.completed)?.payload).toMatchObject({
        executionId: "exec-invalid-settlement",
        settlement: {
          status: "failed",
          error: expect.stringContaining("invalid settlement"),
          failureKind: "runtime",
          phase: "execution",
          executionMayHaveOccurred: true,
          cancellation: "external-work-may-continue",
        },
      });
    });
  });

  it("settles an orphaned execution (started, incarnation died) without re-running it", async () => {
    const stream = new MemoryStream();
    // The dead incarnation's evidence, written before it was evicted.
    await stream.append(
      { type: T.requested, payload: requestPayload("exec-1", "async () => 1") },
      { type: T.started, payload: { executionId: "exec-1" } },
    );
    const processor = makeProcessor({ stream }); // run() throws if invoked
    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: 2 });

    await vi.waitFor(() => {
      const completed = stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "exec-1",
        settlement: {
          status: "failed",
          error: expect.stringContaining("orphaned"),
          failureKind: "orphaned",
          phase: "recovery",
          executionMayHaveOccurred: true,
          cancellation: "external-work-may-continue",
        },
      });
    });
  });

  it("settles a recovery backlog in one bounded atomic append", async () => {
    const stream = new MemoryStream();
    await stream.append(
      { type: T.requested, payload: requestPayload("exec-1", "async () => 1") },
      { type: T.started, payload: { executionId: "exec-1" } },
      { type: T.requested, payload: requestPayload("exec-2", "async () => 2") },
      { type: T.started, payload: { executionId: "exec-2" } },
    );
    const append = vi.spyOn(stream, "append");
    const processor = makeProcessor({ stream });

    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: 4 });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]).toMatchObject([
      { type: T.completed, payload: { executionId: "exec-1" } },
      { type: T.completed, payload: { executionId: "exec-2" } },
    ]);
  });

  it("recovers a request whose incarnation died BEFORE any attempt started (provably never ran → runs it)", async () => {
    const stream = new MemoryStream();
    await stream.append({
      type: T.requested,
      payload: requestPayload("exec-2", "async () => 2"),
    });
    const ran: string[] = [];
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return { status: "succeeded", result: 42 };
      },
    });
    // A later batch (e.g. the revival fact) — the requested event itself is
    // NOT in it; recovery reads the fold, not the batch.
    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: 1 });
    await vi.waitFor(() => {
      expect(stream.events.some((event) => event.type === T.completed)).toBe(true);
    });
    expect(ran).toEqual(["async () => 2"]);
  });

  it("a failed started-append leaves the obligation requested (no body run, no completion) and retries", async () => {
    const stream = new MemoryStream();
    let failStartedAppends = true;
    const realAppend = stream.append.bind(stream);
    stream.append = async (...inputs) => {
      if (failStartedAppends && inputs.some((input) => input.type === T.started)) {
        throw new Error("stream hiccup");
      }
      return realAppend(...inputs);
    };
    const ran: string[] = [];
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return { status: "succeeded", result: "ok" };
      },
    });
    await realAppend({
      type: T.requested,
      payload: requestPayload("exec-5", "async () => 5"),
    });
    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: 1 });
    // Give the failed attempt a beat: nothing may have run or settled — the
    // evidence rule ("no started fact ⇒ never ran") must stay true.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual([]);
    expect(stream.events.some((event) => event.type === T.completed)).toBe(false);
    expect(processor.state.scriptExecutions["exec-5"]).toMatchObject({ status: "requested" });

    // The stream recovers; the next reconciliation (any batch — even one of
    // events this processor does not consume) retries the whole attempt from
    // the fold.
    failStartedAppends = false;
    const [nudge] = await realAppend({ type: "events.iterate.com/test/nudge", payload: {} });
    await ingestTestBatch(processor, { events: [nudge!], streamMaxOffset: nudge!.offset });
    await vi.waitFor(() => {
      const completed = stream.events.find(
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

  it("stops retrying failed start evidence at the absolute expiry and settles without running", async () => {
    let now = Date.now();
    const expiresAt = now + SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS + 100;
    const stream = new MemoryStream();
    let startedAppendAttempts = 0;
    const realAppend = stream.append.bind(stream);
    stream.append = async (...inputs) => {
      if (inputs.some((input) => input.type === T.started)) {
        startedAppendAttempts += 1;
        throw new Error("stream unavailable");
      }
      return realAppend(...inputs);
    };
    const run = vi.fn(async () => ({ status: "succeeded" as const, result: "impossible" }));
    const processor = makeProcessor({ stream, now: () => now, run });
    const [requested] = await realAppend({
      type: T.requested,
      payload: { code: "async () => 6", executionId: "exec-6", expiresAt },
    });

    await ingestTestBatch(processor, {
      events: [requested!],
      streamMaxOffset: requested!.offset,
    });
    await vi.waitFor(() => expect(startedAppendAttempts).toBe(1));
    expect(run).not.toHaveBeenCalled();

    // Once the request's one absolute horizon has passed, reconciliation may
    // only close it as provably never run. It must not make another attempt to
    // journal a start, even though the previous transport failure recovered.
    now = expiresAt + 1;
    const [nudge] = await realAppend({ type: "events.iterate.com/test/nudge", payload: {} });
    await ingestTestBatch(processor, { events: [nudge!], streamMaxOffset: nudge!.offset });

    await vi.waitFor(() => {
      expect(stream.events.find((event) => event.type === T.completed)?.payload).toMatchObject({
        executionId: "exec-6",
        settlement: {
          status: "failed",
          failureKind: "expired",
          phase: "before-execution",
          executionMayHaveOccurred: false,
          cancellation: "not-applicable",
        },
      });
    });
    expect(startedAppendAttempts).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("settles an expired request without running it (only-settle-past-expiry)", async () => {
    const stream = new MemoryStream();
    await stream.append({
      type: T.requested,
      payload: {
        code: "async () => 3",
        executionId: "exec-3",
        expiresAt: Date.now() - 1, // the host slept past the intent's horizon
      },
    });
    const processor = makeProcessor({ stream }); // run() throws if invoked
    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: 1 });

    await vi.waitFor(() => {
      const completed = stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "exec-3",
        settlement: {
          status: "failed",
          error: expect.stringContaining("expired"),
          failureKind: "expired",
          phase: "before-execution",
          executionMayHaveOccurred: false,
          cancellation: "not-applicable",
        },
      });
    });
  });

  it("reserves a bounded settlement window before the request's absolute deadline", async () => {
    const now = Date.now();
    const expiresAt = now + 30_000;
    const executionExpiresAt = expiresAt - SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS;
    const stream = new MemoryStream();
    const run = vi.fn(
      async (): Promise<ScriptExecutionSettlement> => ({
        status: "failed",
        error:
          "Script execution exceeded its absolute deadline after it started. Its worker execution context ended, but arbitrary external work cannot be proven terminated. It may have partially executed; it was NOT re-run.",
        failureKind: "deadline",
        phase: "execution",
        executionMayHaveOccurred: true,
        cancellation: "external-work-may-continue",
      }),
    );
    const processor = makeProcessor({ stream, run });
    const [requested] = await stream.append({
      type: T.requested,
      payload: {
        code: 'async (itx) => { const sandbox = await itx.sandboxes.get("/sandboxes/iterate-live-clocks"); return sandbox.exec("pnpm typecheck", { timeout: 1200000 }); }',
        executionId: "agent-output:13980",
        expiresAt,
      },
    });

    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: requested!.offset });

    await vi.waitFor(() => {
      expect(stream.events.find((event) => event.type === T.completed)?.payload).toMatchObject({
        executionId: "agent-output:13980",
        settlement: {
          status: "failed",
          error: expect.stringMatching(/deadline.*execution context ended/i),
        },
      });
    });
    expect(run).toHaveBeenCalledWith(expect.any(String), {
      emittedJs: undefined,
      expiresAt: executionExpiresAt,
    });
  });

  it("bounds a worker RPC that never returns and journals the classified outcome", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const expiresAt = Date.now() + 30_000;
      const stream = new MemoryStream();
      const run = vi.fn(() => new Promise<ScriptExecutionSettlement>(() => {}));
      const processor = makeProcessor({ stream, now: Date.now, run });
      const [requested] = await stream.append({
        type: T.requested,
        payload: {
          code: "async () => neverReturns()",
          executionId: "exec-wedged-worker-rpc",
          expiresAt,
        },
      });

      await ingestTestBatch(processor, {
        events: [requested!],
        streamMaxOffset: requested!.offset,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledOnce();
      expect(stream.events.some((event) => event.type === T.started)).toBe(true);

      await vi.advanceTimersByTimeAsync(
        expiresAt - SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS - Date.now(),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(stream.events.find((event) => event.type === T.completed)?.payload).toMatchObject({
        executionId: "exec-wedged-worker-rpc",
        settlement: {
          status: "failed",
          failureKind: "deadline",
          phase: "execution",
          executionMayHaveOccurred: true,
          cancellation: "external-work-may-continue",
          error: expect.stringMatching(/host stopped waiting.*NOT re-run/i),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a wedged completion append and retries the exact known settlement", async () => {
    vi.useFakeTimers();
    const backgroundError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.setSystemTime(10_000);
      const stream = new MemoryStream();
      const realAppend = stream.append.bind(stream);
      let hangCompletion = true;
      stream.append = async (...inputs) => {
        if (hangCompletion && inputs.some((input) => input.type === T.completed)) {
          return await new Promise<never>(() => {});
        }
        return realAppend(...inputs);
      };
      const run = vi.fn(
        async (): Promise<ScriptExecutionSettlement> => ({
          status: "succeeded",
          result: "finished",
        }),
      );
      const processor = makeProcessor({ now: Date.now, run, stream });
      const [requested] = await realAppend({
        type: T.requested,
        payload: {
          code: "async () => 'finished'",
          executionId: "exec-wedged-completion",
          expiresAt: Date.now() + 30_000,
        },
      });

      await ingestTestBatch(processor, {
        events: [requested!],
        streamMaxOffset: requested!.offset,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledOnce();
      expect(stream.events.some((event) => event.type === T.started)).toBe(true);

      // The append attempt gets only the reserved settlement interval. Its
      // timeout rejects the tracked attempt and clears the incarnation's live
      // marker; it cannot leave the obligation locally "running" forever.
      // The already-known result remains in the settlement outbox.
      await vi.advanceTimersByTimeAsync(SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(stream.events.some((event) => event.type === T.completed)).toBe(false);

      hangCompletion = false;
      const [nudge] = await realAppend({ type: "events.iterate.com/test/nudge", payload: {} });
      const undelivered = stream.events.filter((event) => event.offset > requested!.offset);
      await ingestTestBatch(processor, { events: undelivered, streamMaxOffset: nudge!.offset });

      const completed = stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "exec-wedged-completion",
        settlement: {
          status: "succeeded",
          result: "finished",
        },
      });
      expect(run).toHaveBeenCalledOnce();
      expect(backgroundError).toHaveBeenCalledWith(
        "stream processor background work failed",
        expect.objectContaining({
          message: expect.stringContaining("record the settlement"),
        }),
      );
    } finally {
      backgroundError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a completion settles the obligation for good: replayed batches change nothing", async () => {
    const stream = new MemoryStream();
    const processor = makeProcessor({
      stream,
      run: async () => ({ status: "succeeded", result: "done" }),
    });
    await stream.append({
      type: T.requested,
      payload: requestPayload("exec-4", "async () => 4"),
    });
    await ingestTestBatch(processor, { events: stream.events, streamMaxOffset: 1 });
    await vi.waitFor(() => {
      expect(stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
    });

    // A fresh incarnation replaying the WHOLE journal (checkpoint reset):
    // the fold re-creates and re-settles the obligation in order; the
    // idempotent completion append collapses at the dedup layer.
    const replayer = makeProcessor({ stream }); // run() throws if invoked
    await ingestTestBatch(replayer, {
      events: stream.events,
      streamMaxOffset: stream.events.at(-1)!.offset,
    });
    expect(stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
  });
});
import { ingestTestBatch } from "~/test/stream-delivery.ts";
