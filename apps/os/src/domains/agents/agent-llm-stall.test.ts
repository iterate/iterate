// The attempt-progress watchdog's contract: an in-flight LLM attempt that
// shows no progress (no chunk since the dial, or chunks that stopped) for
// LLM_ATTEMPT_IDLE_BUDGET_MS (45s) is settled `failed` from the processor's
// side — without waiting on the transport promise (which a severed pager
// socket or hung provider read may never resolve, and which may ignore its
// abort signal). The failed settle feeds the existing 10/20/40s retry
// ladder, which owns re-dialing.
//
// History these were the expected-fail pins for (tasks/platform-stall-repros.md):
// - Mid-stream stall: preview-15 /agents/onboarding, 2026-08-21 — 19 chunks
//   over ~1.3s, then silence past the 10-minute horizon; the expiry settle
//   ran only on delivery, and the first self-driven wake was the keepalive
//   wedge breaker at ~15min.
// - Eviction churn: PR #2529's preview run (Depot w1hcwnlc3q, preview_6,
//   2026-08-27) — first turns took 150s/183s because each severed re-dial
//   was invisible until a 30-40s staleness wake; quiet-stream worst case
//   measured at 15m10s. A hung attempt never FAILED, so the ladder never
//   started.

import { expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";

it("a mid-stream stall (chunks, then silence) settles the request within 60s of the last chunk without any delivery", async () => {
  const h = makeStallHarness();
  await h.play(
    ["append", ...NEW_AGENT_EVENTS, userMessage("Hello there")],
    ["advanceTime", 10_000], // debounce closes → request adopted → transport dialed
  );
  expect(h.llm.calls).toHaveLength(1);
  expect(h.state().openRequest).not.toBeNull();

  // The transport streams a few deltas and then goes quiet forever. A second
  // of time-to-first-token elapses the coalescing window, so the first chunk
  // flushes its own llm-response-chunks event; the rest sit in the buffer,
  // which never flushes on a stream that never ends.
  await h.play(["advanceTime", 1000]);
  await h.play(() => h.llm.streamChunks(["Hel", "lo ", "the"]));
  expect(h.events(RESPONSE_CHUNKS)).toMatchObject([{ payload: { chunks: ["Hel"], sequence: 0 } }]);

  // 60 seconds of silence, no deliveries. The watchdog trips at 45s idle
  // and settles the attempt failed — self-driven, from the processor side.
  await h.play(["advanceTime", 60_000]);
  expect(h.events(SETTLED)).toMatchObject([{ payload: { result: { status: "failed" } } }]);

  // The failed settle is what hands the turn to the retry ladder: give the
  // backoff room and the next attempt dials. (The original expected-fail
  // version asserted openRequest ends null; the real contract is stronger —
  // the turn RETRIES, so a fresh request legitimately opens.)
  await h.play(["advanceTime", 60_000]);
  expect(h.llm.calls.length).toBeGreaterThanOrEqual(2);
});

// The eviction-churn sibling — the routine path on a loaded preview
// deployment. Eviction recovery itself always worked (#2480: revival +
// adopt re-dial within ~10s); what was missing is the re-dialed attempt's
// own progress deadline when it goes out during the same churn window and
// hangs too. The successor arms a fresh watchdog at dial, so a severed
// re-dial now costs one idle budget + a ladder step instead of a
// 30-40s-to-15min detection gap.
it("an attempt orphaned by eviction whose re-dial also hangs makes progress within 60s of the revival", async () => {
  const h = makeStallHarness();
  await h.play(
    ["append", ...NEW_AGENT_EVENTS, userMessage("Hello there")],
    ["advanceTime", 10_000], // debounce closes → request adopted → transport dialed
  );
  expect(h.llm.calls).toHaveLength(1);
  expect(h.state().openRequest).not.toBeNull();

  // Eviction mid-attempt. The successor incarnation stays detached until its
  // first keepalive alarm (~10s) appends the revival fact; delivering that
  // fact runs adopt recovery, which re-dials. This part works.
  await h.play(["crash"], ["advanceTime", 10_000]);
  expect(h.events(REVIVED)).toHaveLength(1);
  expect(h.llm.calls).toHaveLength(2);

  // The re-dial went out during the same churn window that evicted the
  // incarnation, so its transport hangs too (dead pager socket: chunks never
  // arrive, the promise never settles, the abort signal is ignored). A
  // quiet minute passes — no deliveries. The successor's watchdog trips at
  // 45s idle and settles the hung re-dial failed.
  await h.play(["advanceTime", 60_000]);
  expect(h.events(SETTLED)).toMatchObject([{ payload: { result: { status: "failed" } } }]);
});

// The watchdog must not punish a slow-but-progressing attempt: chunks with
// gaps inside the 45s idle budget keep refreshing it, indefinitely.
it("a slow but chunking attempt is never tripped by the watchdog", async () => {
  const h = makeStallHarness();
  await h.play(
    ["append", ...NEW_AGENT_EVENTS, userMessage("Hello there")],
    ["advanceTime", 10_000],
  );
  expect(h.llm.calls).toHaveLength(1);

  // Three minutes of trickling chunks, each gap well under the 45s budget.
  for (let i = 0; i < 6; i++) {
    await h.play(["advanceTime", 30_000], () => h.llm.streamChunks([`chunk-${i} `]));
  }
  expect(h.events(SETTLED)).toEqual([]);
  expect(h.state().openRequest).not.toBeNull();
  expect(h.llm.calls).toHaveLength(1);
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type AgentEventInput = ConsumedInput<AgentProcessorContract>;

const SETTLED = "events.iterate.com/agent/llm-request-settled";
const RESPONSE_CHUNKS = "events.iterate.com/agent/llm-response-chunks";
const REVIVED = "events.iterate.com/stream/processor-revived";

const NEW_AGENT_EVENTS = [
  { type: "events.iterate.com/agent/created", payload: {} },
  {
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "test-model" } } },
  },
  {
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "system",
      key: "agent/system-prompt",
      content: "You are a helpful test agent.",
    },
  },
] satisfies AgentEventInput[];

function userMessage(content: string): AgentEventInput {
  return {
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "user",
      content,
      actor: { type: "user", origin: "web" },
      llmRequestPolicy: { behaviour: "after-current-request" },
    },
  };
}

/**
 * A transport that dies mid-stream. It delivers chunks on demand and then
 * NEVER resolves or rejects — and deliberately ignores the abort signal. The
 * scripted transport in agent-processor.test.ts rejects on abort, which lets
 * the attempt's catch path run; a real fetch body read that has gone silent
 * gives no such guarantee. Any stall fix must settle the request from the
 * processor's side without waiting on the transport promise, so this
 * transport models the harshest case: no settle will ever come from it.
 */
function makeDeadStreamLlm() {
  const calls: { onChunk?: (text: string) => Promise<void>; signal: AbortSignal }[] = [];
  return {
    calls,
    async streamChunks(chunks: string[]) {
      for (const chunk of chunks) await calls.at(-1)!.onChunk!(chunk);
    },
    transport: (args: { signal: AbortSignal; onChunk?: (text: string) => Promise<void> }) =>
      new Promise<{ text: string }>(() => {
        calls.push(args);
      }),
  };
}

function makeStallHarness() {
  const llm = makeDeadStreamLlm();
  const harness = makeProcessorHarness<AgentProcessorContract>({
    createProcessor: (deps) => new AgentProcessor({ ...deps, callLlm: llm.transport }),
    path: "/agents/test",
  });
  return { ...harness, llm };
}
