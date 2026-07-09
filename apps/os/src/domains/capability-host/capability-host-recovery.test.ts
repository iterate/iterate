// Script-execution recovery: the capability-host processor's end-of-batch
// reconciliation of journaled script obligations against this incarnation's
// live executions — the same doctrine as the LLM providers, with the
// script-specific policy that a `started` obligation is settled as failure
// and NEVER re-run (scripts may have half-executed non-idempotent effects).

import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import { CapabilityHostProcessor } from "./capability-host-processor-implementation.ts";

const T = {
  requested: "events.iterate.com/capability-host/script-execution-requested",
  started: "events.iterate.com/capability-host/script-execution-started",
  completed: "events.iterate.com/capability-host/script-execution-completed",
} as const;

function makeProcessor(options: {
  stream: MemoryStream;
  run?: (code: string) => Promise<unknown>;
}) {
  return new CapabilityHostProcessor({
    stream: options.stream,
    itx: {} as Project,
    path: "/",
    projectId: null,
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
  it("runs a fresh request: started evidence lands before the body, completion after", async () => {
    const stream = new MemoryStream();
    const ran: string[] = [];
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        // The started fact must already be durable when the body runs.
        expect(stream.events.some((event) => event.type === T.started)).toBe(true);
        ran.push(code);
        return { ok: true };
      },
    });
    const [requested] = await stream.append({
      type: T.requested,
      payload: { code: "async () => 1", executionId: "exec-1" },
    });
    await processor.ingest({ events: stream.events, streamMaxOffset: requested!.offset });

    await vi.waitFor(() => {
      const completed = stream.events.find((event) => event.type === T.completed);
      expect(completed?.idempotencyKey).toBe("capability-host/script-execution-completed@exec-1");
      expect(completed?.payload).toMatchObject({ executionId: "exec-1", result: { ok: true } });
    });
    expect(ran).toEqual(["async () => 1"]);
  });

  it("settles an orphaned execution (started, incarnation died) without re-running it", async () => {
    const stream = new MemoryStream();
    // The dead incarnation's evidence, written before it was evicted.
    await stream.append(
      { type: T.requested, payload: { code: "async () => 1", executionId: "exec-1" } },
      { type: T.started, payload: { executionId: "exec-1" } },
    );
    const processor = makeProcessor({ stream }); // run() throws if invoked
    await processor.ingest({ events: stream.events, streamMaxOffset: 2 });

    await vi.waitFor(() => {
      const completed = stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "exec-1",
        error: expect.stringContaining("orphaned"),
      });
    });
  });

  it("recovers a request whose incarnation died BEFORE any attempt started (provably never ran → runs it)", async () => {
    const stream = new MemoryStream();
    await stream.append({
      type: T.requested,
      payload: { code: "async () => 2", executionId: "exec-2" },
    });
    const ran: string[] = [];
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return 42;
      },
    });
    // A later batch (e.g. the revival fact) — the requested event itself is
    // NOT in it; recovery reads the fold, not the batch.
    await processor.ingest({ events: stream.events, streamMaxOffset: 1 });
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
        return "ok";
      },
    });
    await realAppend({
      type: T.requested,
      payload: { code: "async () => 5", executionId: "exec-5" },
    });
    await processor.ingest({ events: stream.events, streamMaxOffset: 1 });
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
    await processor.ingest({ events: [nudge!], streamMaxOffset: nudge!.offset });
    await vi.waitFor(() => {
      const completed = stream.events.find(
        (event) =>
          event.type === T.completed &&
          (event.payload as { executionId: string }).executionId === "exec-5",
      );
      expect(completed?.payload).toMatchObject({ executionId: "exec-5", result: "ok" });
    });
    expect(ran).toEqual(["async () => 5"]);
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
    await processor.ingest({ events: stream.events, streamMaxOffset: 1 });

    await vi.waitFor(() => {
      const completed = stream.events.find((event) => event.type === T.completed);
      expect(completed?.payload).toMatchObject({
        executionId: "exec-3",
        error: expect.stringContaining("expired"),
      });
    });
  });

  it("a completion settles the obligation for good: replayed batches change nothing", async () => {
    const stream = new MemoryStream();
    const processor = makeProcessor({ stream, run: async () => "done" });
    await stream.append({
      type: T.requested,
      payload: { code: "async () => 4", executionId: "exec-4" },
    });
    await processor.ingest({ events: stream.events, streamMaxOffset: 1 });
    await vi.waitFor(() => {
      expect(stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
    });

    // A fresh incarnation replaying the WHOLE journal (checkpoint reset):
    // the fold re-creates and re-settles the obligation in order; the
    // idempotent completion append collapses at the dedup layer.
    const replayer = makeProcessor({ stream }); // run() throws if invoked
    await replayer.ingest({
      events: stream.events,
      streamMaxOffset: stream.events.at(-1)!.offset,
    });
    expect(stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
  });
});
