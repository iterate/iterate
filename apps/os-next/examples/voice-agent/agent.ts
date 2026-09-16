/**
 * The project's agent, as a small os-next facet processor on the conversation context beside the
 * voice relay. The voice facet emits `delegation-requested` when the live model hands off a
 * request; this facet consumes it, runs one chat-model turn (delegation-turn.ts: a model over the
 * words so far, one script tool against `itx`), and emits the answer as `commentary` naming the
 * same delegationId. The voice facet forwards that commentary to the live model to speak.
 *
 * Separate from the relay on purpose: the turn's answer is durable, so an eviction mid-turn is
 * recovered from this facet's own fold on the next catch-up, and the voice socket dying does not
 * take the answer with it.
 */
import {
  StreamProcessor,
  StreamProcessorDurableObject,
  defineProcessorContract,
  z,
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
} from "./processor.js";
import {
  completeWithOpenAi,
  runDelegationTurn,
  type DelegationTurnDeps,
} from "./delegation-turn.ts";

/** The requests this facet remembers as unanswered — a call raises them one at a time, so a
 * handful covers any real backlog while bounding the fold. */
const MAX_PENDING_DELEGATIONS = 16;

const Activation = z.string().min(1).max(64);
const Transcript = z.array(z.object({ role: z.enum(["listener", "assistant"]), text: z.string() }));

/** A delegation the agent has not yet answered: the request and the words that came with it. */
const PendingDelegation = z.object({
  activation: Activation,
  delegationId: z.string(),
  transcript: Transcript,
});

const AgentState = z.object({
  /** Raised by `delegation-requested`, removed by the `commentary` that answers it; newest first.
   * The recovery ground: a pending row still here after an eviction is re-run. */
  pending: z.array(PendingDelegation).max(MAX_PENDING_DELEGATIONS).default([]),
});

const AgentContract = defineProcessorContract({
  slug: "agent",
  version: "1.0.0",
  description:
    "Answers the voice relay's delegations with one chat-model turn, on the conversation context beside it.",
  stateSchema: AgentState,
  events: {
    "events.iterate.com/voice-agent/delegation-requested": {
      description: "The live model handed a request to the backend, with the words said so far.",
      payloadSchema: z.looseObject({
        activation: Activation,
        conversationId: z.string(),
        delegationId: z.string(),
        transcript: Transcript,
      }),
    },
    "events.iterate.com/voice-agent/thinking": {
      description: "A backend note for the live model to use quietly.",
      payloadSchema: z.object({
        activation: Activation,
        delegationId: z.string().nullable(),
        content: z.string().min(1).max(8_000),
      }),
    },
    "events.iterate.com/voice-agent/commentary": {
      description: "The backend's answer for the live model to paraphrase aloud.",
      payloadSchema: z.object({
        activation: Activation,
        delegationId: z.string().nullable(),
        content: z.string().min(1).max(8_000),
        hangUp: z.boolean().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/delegation-requested",
    /* Its own answer: consumed so the pending row it settles leaves the fold. */
    "events.iterate.com/voice-agent/commentary",
  ],
  emits: ["events.iterate.com/voice-agent/commentary", "events.iterate.com/voice-agent/thinking"],
});
type AgentContract = typeof AgentContract;

type AgentState = z.infer<typeof AgentState>;
type AgentArgs = ProcessEventArgs<AgentState, ConsumedEvent<AgentContract>>;

/** What the host injects: the model call and the script tool (delegation-turn.ts). */
export type AgentDeps = {
  complete: DelegationTurnDeps["complete"];
  runScript: DelegationTurnDeps["runScript"];
};

class AgentProcessor extends StreamProcessor<AgentState, ConsumedEvent<AgentContract>> {
  readonly contract = AgentContract;

  constructor(private readonly deps: AgentDeps) {
    super();
  }

  /** Delegations this incarnation is answering right now, so a re-delivery or a mic-frame catch-up
   * pass does not start a second turn for one already running. */
  readonly #turnsInFlight = new Set<string>();

  reduce({ state, event }: ReduceArgs<AgentState, ConsumedEvent<AgentContract>>) {
    switch (event.type) {
      case "events.iterate.com/voice-agent/delegation-requested": {
        const { activation, delegationId, transcript } = event.payload;
        if (state.pending.some((row) => row.delegationId === delegationId)) return state;
        return {
          ...state,
          pending: [{ activation, delegationId, transcript }, ...state.pending].slice(
            0,
            MAX_PENDING_DELEGATIONS,
          ),
        };
      }

      case "events.iterate.com/voice-agent/commentary": {
        const { delegationId } = event.payload;
        if (!delegationId) return state;
        const pending = state.pending.filter((row) => row.delegationId !== delegationId);
        return pending.length === state.pending.length ? state : { ...state, pending };
      }

      default:
        return state;
    }
  }

  processEvent(args: AgentArgs): undefined {
    /* Answer from the fold, not from the event: on the caught-up pass every pending delegation not
     * already in flight gets a turn — the delivery that carries `delegation-requested` is itself
     * caught up, so a live request answers with no added latency, and one that outlived an eviction
     * (its commentary never landed) re-runs here on the next catch-up. */
    if (!args.delivery.caughtUp) return;
    for (const pending of args.state.pending) {
      if (this.#turnsInFlight.has(pending.delegationId)) continue;
      this.#turnsInFlight.add(pending.delegationId);
      args.runInBackground(() => this.#answer(pending, args.append));
    }
  }

  async #answer(
    pending: z.infer<typeof PendingDelegation>,
    append: AgentArgs["append"],
  ): Promise<void> {
    const { activation, delegationId, transcript } = pending;
    try {
      const turn = await runDelegationTurn(transcript, {
        complete: this.deps.complete,
        runScript: this.deps.runScript,
        progress: (note) =>
          append({
            type: "events.iterate.com/voice-agent/thinking",
            payload: { activation, delegationId: null, content: note },
          }),
      });
      await append({
        type: "events.iterate.com/voice-agent/commentary",
        idempotencyKey: this.idempotencyKey(`commentary:${delegationId}`),
        payload: {
          activation,
          delegationId,
          content: turn.content,
          ...(turn.hangUp && { hangUp: true }),
        },
      });
    } finally {
      this.#turnsInFlight.delete(delegationId);
    }
  }
}

/** The class the loader hosts: `facets.get("agent", { source, className: "AgentDurableObject" })`. */
export class AgentDurableObject extends StreamProcessorDurableObject<AgentState> {
  processor = new AgentProcessor({
    complete: completeWithOpenAi,
    runScript: async (script) => {
      const itx = this.env.ITX.get() as unknown as { run(script: string): Promise<unknown> };
      try {
        return JSON.stringify((await itx.run(script)) ?? null).slice(0, 8_000);
      } catch (error) {
        return `ERROR: ${String(error instanceof Error ? error.message : error).slice(0, 8_000)}`;
      }
    },
  });
}
