// Expected-fail spec pinning a live platform gap: an LLM attempt that stalls
// MID-STREAM is never settled on its own.
//
// Observed on preview-15, stream /agents/onboarding, 2026-08-21 15:08 and
// 15:11 UTC: the request was recorded, the transport emitted 19 chunks over
// ~1.3s, then went silent. No llm-request-settled, no failure. The request
// stayed open past the 10-minute llmRequestExpiryMs horizon because the
// expiry settle in the turn loop only runs when a delivery wakes the stream,
// and nothing else was being delivered. The user's reply never arrived and
// the next message queued behind the dead attempt.
//
// What this spec asserts (and what is NOT true today): a stall after chunks
// settles the request (failed or cancelled) within a bounded stall budget —
// 60 seconds of virtual time after the last chunk — with no external delivery
// arriving. The 60s is a placeholder for the product decision the fix makes.
//
// Why nothing settles today:
// - There is no stall detection anywhere. With `deps.callLlm` injected the
//   attempt passes no deadline to the transport at all, and in production
//   the Workers AI transport's deadline is whole-phase — the remaining expiry
//   horizon (~10 min) — not a chunk-idle budget.
// - The 10-minute expiry does not fire on its own either: the expiry settle
//   in the turn loop runs on delivery. Under this harness the first
//   self-driven wake is the keepalive's wedge detection
//   (MAX_CONSECUTIVE_BUSY_REFIRES = 90 refires at a 10s lead, ~15 min), whose
//   revival fact is the delivery that finally runs the expiry settle — so the
//   effective bound is ~15 min after dial, and only as a side effect of the
//   keepalive's crash-loop breaker. Same family as the 2026-08-13 prd
//   incident noted in agent-turn-loop.ts.
//
// Fix directions (not taken here): a chunk-idle watchdog on the attempt
// (abort + settle failed when no chunk arrives for N seconds), or
// alarm-driven expiry instead of delivery-driven.

import { expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import { makeProcessorHarness } from "iterate/processors/testing";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";

it.fails("a mid-stream stall (chunks, then silence) settles the request within 60s of the last chunk without any delivery", async () => {
  const h = makeStallHarness();
  await h.play(
    ["append", ...NEW_AGENT_EVENTS, userMessage("Hello there")],
    ["advanceTime", 10_000], // debounce closes → request adopted → transport dialed
  );
  expect(h.llm.calls).toHaveLength(1);
  expect(h.state().openRequest).not.toBeNull();

  // The transport streams a few deltas and then goes quiet forever.
  await h.play(() => h.llm.streamChunks(["Hel", "lo ", "the"]));
  expect(h.events(RESPONSE_CHUNK)).toHaveLength(3);

  // 60 seconds of silence, no deliveries. Today nothing wakes the stream:
  // the whole-phase transport deadline is the remaining expiry horizon
  // (~10 min), and the expiry settle runs only on delivery. Under this
  // harness the first self-driven wake is the keepalive's wedge detection
  // (MAX_CONSECUTIVE_BUSY_REFIRES, ~15 min), whose revival fact is the
  // delivery that finally triggers the expiry settle — so this assertion
  // starts passing somewhere between 14m50s and 15m10s of virtual time.
  await h.play(["advanceTime", 60_000]);

  expect(h.events(SETTLED)).toMatchObject([
    {
      payload: {
        result: { status: expect.stringMatching(/^(failed|cancelled)$/) },
      },
    },
  ]);
  expect(h.state().openRequest).toBeNull();
});

// Expected-fail sibling: the same missing progress deadline, entered through
// EVICTION CHURN instead of a provider stall — the routine path on a loaded
// preview deployment, not a rare provider hiccup.
//
// Observed on PR #2529's preview run (Depot w1hcwnlc3q, preview_6,
// 2026-08-27): the spec suite's first agent turn took 150s and 183s
// end-to-end on its two attempts. The journals (projects
// agent-script-reuse-mtbkj6o8-c56ce7a9 and -mtbkmi8q-b6f3c4e3) show the
// shape: llm-request-requested → silence → stream/woken (staleness alarm)
// → processor-revived → the re-dial ALSO hangs (its pager path died in the
// same churn window) → another silence → another wake — repeating until an
// attempt lands on a healthy path. Each cycle burns a full detection
// window, because a hung attempt never FAILS and the 10/20/40s retry
// ladder (#1826) only starts from a failed one.
//
// This harness pins the quiet-stream worst case, measured here before
// writing the assertion: eviction at t0 → revival + re-dial at t0+10s (the
// adopt recovery works — #2480) → the hung re-dial is then invisible until
// the keepalive wedge breaker at t0+15m10s. A busy stream shortens that to
// minutes (deliveries run the expiry settle sooner), which is exactly the
// 150-183s observed on preview.
//
// What this spec asserts (not true today): within 60s of the revival the
// turn makes progress — the hung attempt is settled (a stall fix aborts it;
// the retry ladder then owns re-dialing) or a fresh attempt is dialed. 60s
// is the same placeholder budget as the mid-stream spec above; the product
// decision belongs to the fix.
it.fails("an attempt orphaned by eviction whose re-dial also hangs makes progress within 60s of the revival", async () => {
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
  // quiet minute passes — no deliveries.
  await h.play(["advanceTime", 60_000]);

  // "No progress" is exactly one shape: still the two dials, zero settles.
  // Today that is what a minute later looks like — and stays looking like
  // until the wedge breaker at ~15m10s after the eviction.
  expect({
    settled: h.events(SETTLED).length,
    attemptsDialed: h.llm.calls.length,
  }).not.toMatchObject({ settled: 0, attemptsDialed: 2 });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type AgentEventInput = ConsumedInput<AgentProcessorContract>;

const SETTLED = "events.iterate.com/agent/llm-request-settled";
const RESPONSE_CHUNK = "events.iterate.com/agent/llm-response-chunk";
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
