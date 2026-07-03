import { StreamProcessor } from "../streams/stream-processor.ts";
import { VOICE_WORKER_IDLE_REPLY, VoiceProcessorContract } from "./voice-processor-contract.ts";

/**
 * Processor for one voice agent stream (`/agents/voice/**`).
 *
 * Voice clients append `voice/user-turn-transcribed` facts; this processor
 * renders each into `agents/user-message-received` — the same fact web chat
 * appends — so the agent core schedules the request normally and the agent
 * feed UI shows the turn as a user message. When the agent replies
 * (`agents/web-message-sent`), the reply is projected into a
 * `voice/say-requested` event for clients to relay out loud — unless it is
 * the worker's "(idle)" sentinel, which is swallowed. Reply→speech dedup is
 * structural: the fold visits each web-message-sent exactly once.
 */
export class VoiceProcessor extends StreamProcessor<typeof VoiceProcessorContract> {
  readonly contract = VoiceProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof VoiceProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/voice/user-turn-transcribed":
        return {
          ...state,
          turnCount: (state.turnCount || 0) + 1,
          recentTurns: [...(state.recentTurns || []), event.payload.transcript].slice(-5),
        };
      case "events.iterate.com/agents/web-message-sent":
        if (event.payload.message.trim() === VOICE_WORKER_IDLE_REPLY) return state;
        return { ...state, sayRequestCount: (state.sayRequestCount || 0) + 1 };
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    previousState,
  }: Parameters<StreamProcessor<typeof VoiceProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/voice/user-turn-transcribed": {
        blockProcessorWhile(async () => {
          // Voice models under test lose cross-turn goals ("give me a topic"
          // right after the user gave one). Jam recent turns against the new
          // one as a non-triggering history input — mechanical salience, so
          // coherence doesn't hinge on the model re-reading a long journal.
          const earlierTurns = previousState.recentTurns || [];
          if (earlierTurns.length > 0) {
            await append({
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: `voice/context-reminder@${event.offset}`,
              payload: {
                content: `(voice conversation context — the user's recent turns, oldest first: ${earlierTurns
                  .map((turn) => JSON.stringify(turn))
                  .join(
                    "; ",
                  )}. If an earlier request is still unanswered, continue working on it now instead of asking again.)`,
                llmRequestPolicy: { behaviour: "dont-trigger-request" },
              },
            });
          }
          await append({
            type: "events.iterate.com/agents/user-message-received",
            idempotencyKey: `voice/render-turn@${event.offset}`,
            payload: { content: event.payload.transcript, origin: "voice" },
          });
        });
        return;
      }
      case "events.iterate.com/agents/web-message-sent": {
        const message = event.payload.message.trim();
        if (message === VOICE_WORKER_IDLE_REPLY) return;
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/voice/say-requested",
            idempotencyKey: `voice/say-requested@${event.offset}`,
            payload: { message, workerReplyOffset: event.offset },
          }),
        );
        return;
      }
      default:
        return;
    }
  }
}
