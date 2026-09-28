/**
 * The project's agent, as a small facet processor on the conversation context beside the voice
 * relay. The voice facet emits `delegation-requested` when the live model hands off a
 * request; this facet consumes it, runs one chat-model turn (delegation-turn.ts: a model over the
 * words so far, one script tool against `itx`), and emits the answer as `commentary-added` naming the
 * same delegationId. The voice facet forwards that commentary to the live model to speak.
 *
 * Separate from the relay on purpose: the turn's answer is durable, so an eviction mid-turn is
 * recovered from this facet's own fold on the next catch-up, and the voice socket dying does not
 * take the answer with it.
 *
 * Its birth as an agent of the project is `itx.agents.create` in worker.ts's setupVoiceAgent,
 * before this facet is subscribed.
 */
import {
  StreamProcessor,
  StreamProcessorDurableObject,
  defineProcessorContract,
  z,
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
} from "iterate/sdk";
import {
  completeWithOpenAi,
  runDelegationTurn,
  type DelegationTurnDeps,
} from "./delegation-turn.ts";
import {
  Activation,
  DelegationRequestedPayload,
  Transcript,
  VOICE_DELEGATE_CONSUMES,
  commentaryEvent,
  thinkingEvent,
} from "./events.ts";

/** The requests this facet remembers as unanswered — a call raises them one at a time, so a
 * handful covers any real backlog while bounding the fold. */
const MAX_PENDING_DELEGATIONS = 16;

/** A delegation the agent has not yet answered: the request and the words that came with it. */
const PendingDelegation = z.object({
  activation: Activation,
  delegationId: z.string(),
  transcript: Transcript,
});

const ContextMessage = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.string(),
});

const VoiceDelegateState = z.object({
  /** Raised by `delegation-requested`, removed by the `commentary-added` that answers it; newest first.
   * The recovery ground: a pending row still here after an eviction is re-run. */
  pending: z.array(PendingDelegation).max(MAX_PENDING_DELEGATIONS).default([]),
  /** Additional conversation context, supplied as ordinary Markdown messages. */
  context: z.array(ContextMessage).default([]),
});

const VoiceDelegateContract = defineProcessorContract({
  slug: "voice-delegate",
  version: "3.0.0",
  description:
    "Answers the voice relay's delegations with one chat-model turn, on the conversation context beside it.",
  stateSchema: VoiceDelegateState,
  events: {
    "events.iterate.com/agent/context-added": {
      description: "Additional messages supplied to the conversation.",
      payloadSchema: ContextMessage,
    },
    "events.iterate.com/voice-agent/delegation-requested": {
      description: "The live model handed a request to the backend, with the words said so far.",
      payloadSchema: DelegationRequestedPayload,
    },
    "events.iterate.com/voice-agent/thinking-added": thinkingEvent,
    "events.iterate.com/voice-agent/commentary-added": commentaryEvent,
  },
  consumes: [...VOICE_DELEGATE_CONSUMES],
  emits: [
    "events.iterate.com/agent/context-added",
    "events.iterate.com/voice-agent/commentary-added",
    "events.iterate.com/voice-agent/thinking-added",
  ],
});
type VoiceDelegateContract = typeof VoiceDelegateContract;

type VoiceDelegateState = z.infer<typeof VoiceDelegateState>;
type VoiceDelegateArgs = ProcessEventArgs<VoiceDelegateState, ConsumedEvent<VoiceDelegateContract>>;

/** What the host injects: the model call and the script tool (delegation-turn.ts). */
type VoiceDelegateDeps = {
  complete: DelegationTurnDeps["complete"];
  runScript: DelegationTurnDeps["runScript"];
};

export class VoiceDelegateProcessor extends StreamProcessor<
  VoiceDelegateState,
  ConsumedEvent<VoiceDelegateContract>
> {
  readonly contract = VoiceDelegateContract;

  private readonly deps: VoiceDelegateDeps;

  constructor(deps: VoiceDelegateDeps) {
    super();
    this.deps = deps;
  }

  /** Delegations this incarnation is answering right now, so a re-delivery or a mic-frame catch-up
   * pass does not start a second turn for one already running. */
  readonly #turnsInFlight = new Set<string>();

  reduce({ state, event }: ReduceArgs<VoiceDelegateState, ConsumedEvent<VoiceDelegateContract>>) {
    switch (event.type) {
      case "events.iterate.com/agent/context-added":
        return { ...state, context: [...state.context, event.payload] };

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

      case "events.iterate.com/voice-agent/commentary-added": {
        const { delegationId } = event.payload;
        if (!delegationId) return state;
        const pending = state.pending.filter((row) => row.delegationId !== delegationId);
        return pending.length === state.pending.length ? state : { ...state, pending };
      }

      default:
        return state;
    }
  }

  processEvent(args: VoiceDelegateArgs): undefined {
    /* Answer from the fold, not from the event: on the caught-up pass every pending delegation not
     * already in flight gets a turn — the delivery that carries `delegation-requested` is itself
     * caught up, so a live request answers with no added latency, and one that outlived an eviction
     * (its commentary never landed) re-runs here on the next catch-up. */
    if (!args.delivery.caughtUp) return;
    for (const pending of args.state.pending) {
      if (this.#turnsInFlight.has(pending.delegationId)) continue;
      this.#turnsInFlight.add(pending.delegationId);
      args.runInBackground(() => this.#answer(pending, args.state.context, args.append));
    }
  }

  async #answer(
    pending: z.infer<typeof PendingDelegation>,
    context: VoiceDelegateState["context"],
    append: VoiceDelegateArgs["append"],
  ): Promise<void> {
    const { activation, delegationId, transcript } = pending;
    try {
      const turn = await runDelegationTurn(
        transcript,
        {
          complete: this.deps.complete,
          runScript: this.deps.runScript,
          remember: (messages) =>
            append(
              ...messages.map((payload) => ({
                type: "events.iterate.com/agent/context-added",
                payload,
              })),
            ),
          progress: (note) =>
            append({
              type: "events.iterate.com/voice-agent/thinking-added",
              payload: { activation, delegationId: null, content: note },
            }),
        },
        context,
      );
      await append({
        type: "events.iterate.com/voice-agent/commentary-added",
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

/** The class the loader hosts: `facets.get("voice-delegate", { source, className: "VoiceDelegateDurableObject" })`. */
export class VoiceDelegateDurableObject extends StreamProcessorDurableObject<VoiceDelegateState> {
  /** `itx.whoami()`, read once per incarnation: every model step of every turn names the project. */
  #identity?: string;

  processor = new VoiceDelegateProcessor({
    complete: async (messages) => {
      this.#identity ??= JSON.stringify(await this.withItx((itx) => itx.whoami()));
      return completeWithOpenAi([
        {
          role: "system",
          content: `CURRENT PROJECT: ${this.#identity}. Use projectUrl for website requests and verification.`,
        },
        ...messages,
      ]);
    },
    runScript: async (script) => {
      try {
        const result = await this.withItx((itx) => itx.run(script));
        return JSON.stringify(result ?? null).slice(0, 8_000);
      } catch (error) {
        return `ERROR: ${String(error instanceof Error ? error.message : error).slice(0, 8_000)}`;
      }
    },
  });
}
