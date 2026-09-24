/**
 * The voice events both processors on a call's context declare: the relay (voice-agent.ts) raises
 * `delegation-requested` and speaks `thinking-added`/`commentary-added`; the delegate (voice-delegate.ts)
 * answers the one with the others. Declared once so the two contracts cannot drift apart.
 */
import { z } from "./processor.js";

/** The device's call identity: the press mints it, the frames carry it. */
export const Activation = z.string().min(1).max(64);

/** The words said so far, as `delegation-requested` carries them. */
export const Transcript = z.array(
  z.object({ role: z.enum(["listener", "assistant"]), text: z.string() }),
);

export const DelegationRequestedPayload = z.looseObject({
  activation: Activation,
  conversationId: z.string(),
  delegationId: z.string(),
  transcript: Transcript,
});

export const thinkingEvent = {
  description: "A backend note for the live model to use quietly.",
  payloadSchema: z.object({
    activation: Activation,
    delegationId: z.string().nullable(),
    content: z.string().min(1).max(8_000),
  }),
};

export const commentaryEvent = {
  description: "The backend's answer for the live model to paraphrase aloud.",
  payloadSchema: z.object({
    activation: Activation,
    delegationId: z.string().nullable(),
    content: z.string().min(1).max(8_000),
    hangUp: z.boolean().optional(),
  }),
};

/** What the delegate consumes, and so what worker.ts subscribes it to. */
export const VOICE_DELEGATE_CONSUMES = [
  "events.iterate.com/agent/context-added",
  "events.iterate.com/voice-agent/delegation-requested",
  /* Its own answer: consumed so the pending row it settles leaves the fold. */
  "events.iterate.com/voice-agent/commentary",
] as const;
