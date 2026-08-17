// A minimal, self-contained example of the shape the platform's own
// AgentProcessor has — written entirely in userspace and hosted as a FACET of
// the stream it serves. It exists to show two things a real agent must get
// right, in as little code as possible:
//
//   1. the OBLIGATION pattern — an event opens a "must happen" piece of work
//      (here, produce a reply), a droppable background attempt does it, and the
//      work is RESTARTED from committed stream state if the attempt is lost;
//   2. RECOVERY — a facet has no alarm of its own, so the platform keeps a
//      keepalive alarm on its behalf; an incarnation that dies mid-work is
//      revived in a fresh one and the obligation still completes.
//
// A real agent's "produce a reply" is an LLM call; here it is a deliberate
// delay, so the example needs no credentials and the recovery behaviour is the
// only thing on show. See docs/writing-stream-processors.md for the full
// doctrine this condenses.
//
// Kept intentionally minimal — a production obligation adds three things this
// example omits so the recovery mechanics stay legible: an `expiresAt` on the
// request so a revival long after the fact fails-closed instead of acting on a
// stale intent; a single `…-settled` terminal event with a success/failure
// result union (not a bare `…-produced`); and `this.idempotencyKey(...)` for
// the settlement key. The doc's "Staleness" and "obligation pattern" sections
// cover all three.
//
// To host it, a project configures one `facet-processor` subscription whose
// `source` is `{ kind: "userspace", worker: <ref to this file's ExampleAgent> }`
// (apps/os `example-agent-recovery.e2e.test.ts` does exactly that).

import { StreamProcessorFacet, type ProcessorHostDeps } from "iterate/sdk";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "iterate/processors";
import { z } from "zod";

const PROMPT_RECEIVED = "events.example/agent/prompt-received";
const REPLY_PRODUCED = "events.example/agent/reply-produced";

export const ExampleAgentContract = defineProcessorContract({
  slug: "example-agent",
  version: "1.0.0",
  description: "Produces one reply per prompt via a slow, recovery-backed attempt.",
  // Reduced state is the whole source of truth: which prompts still owe a reply,
  // and every reply produced. It survives eviction; the in-memory attempt does not.
  stateSchema: z.object({
    pending: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
    replies: z.array(z.object({ id: z.string(), reply: z.string() })).default([]),
  }),
  events: {
    [PROMPT_RECEIVED]: {
      description: "Opens the obligation: this prompt now owes a reply.",
      payloadSchema: z.object({ id: z.string(), text: z.string() }),
    },
    [REPLY_PRODUCED]: {
      description: "Settles the obligation: the reply for this prompt.",
      payloadSchema: z.object({ id: z.string(), reply: z.string() }),
    },
  },
  consumes: [PROMPT_RECEIVED, REPLY_PRODUCED],
  emits: [REPLY_PRODUCED],
});
export type ExampleAgentContract = typeof ExampleAgentContract;

class ExampleAgentProcessor extends StreamProcessor<ExampleAgentContract> {
  readonly contract = ExampleAgentContract;

  // The ids this incarnation is already generating a reply for. In-memory on
  // purpose: an eviction empties it, and an empty live-set is precisely what
  // makes the at-head pass below restart a reply that was lost mid-flight.
  readonly #generating = new Set<string>();

  protected override reduce({ state, event }: ReduceArgs<ExampleAgentContract>) {
    if (event.type === PROMPT_RECEIVED) {
      return { ...state, pending: [...state.pending, event.payload] };
    }
    // A produced reply closes its obligation: drop it from pending, record it.
    return {
      ...state,
      pending: state.pending.filter((prompt) => prompt.id !== event.payload.id),
      replies: [...state.replies, event.payload],
    };
  }

  protected override processEvent({
    state,
    delivery,
    append,
    runInBackground,
  }: ProcessEventArgs<ExampleAgentContract>): undefined {
    // Act only from the at-head fold. Behind the head, `pending` may not yet
    // have absorbed a reply that is already committed further up the stream, so
    // starting here could generate a duplicate. This one guard is what makes
    // the processor safe to replay, and it is also the recovery entry point:
    // after a revival the runner calls this once with the whole fold and
    // caughtUp: true.
    if (!delivery.caughtUp) return;
    for (const prompt of state.pending) {
      if (this.#generating.has(prompt.id)) continue; // already handled this incarnation
      this.#generating.add(prompt.id);
      // A DROPPABLE attempt: the checkpoint advances now and an eviction loses
      // this closure silently. That is fine because the obligation is recovered
      // from `pending` above — this same branch restarts it. The reply's stable
      // idempotency key makes the restart converge (a redelivered reply dedupes).
      runInBackground(async () => {
        try {
          const reply = await generateReply(prompt.text);
          await append({
            type: REPLY_PRODUCED,
            idempotencyKey: `reply@${prompt.id}`,
            payload: { id: prompt.id, reply },
          });
        } finally {
          this.#generating.delete(prompt.id);
        }
      });
    }
  }
}

/**
 * Stand in for the slow, must-complete work a real agent does (an LLM call).
 * The delay is the whole point of the example: kill the host while it is
 * running and the reply still lands, because recovery restarts the attempt.
 */
async function generateReply(text: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  return `Reply to: ${text}`;
}

/**
 * The hosted facet. A subclass writes only how to build its processor (and that
 * it owes background work, so `recovery` is on); the `StreamProcessorFacet` base
 * supplies the rest — the itx-proxied keepalive alarm, the stream handle, and
 * the configure/wake/handleAlarm wiring. The SAME processor would run as its own
 * Durable Object by extending `StreamProcessorDurableObject` instead.
 */
export class ExampleAgent extends StreamProcessorFacet {
  protected override readonly recovery = true;
  protected override createProcessor(deps: ProcessorHostDeps) {
    return new ExampleAgentProcessor(deps);
  }
}
