// Contract for the "voice" processor that runs on voice agent streams
// (`/agents/voice/**`). It is the durable brain of the voice ↔ itx
// multiplexer: realtime voice clients (the dashboard voice page, the CLI
// bridge) are thin I/O pumps that append raw conversation facts here and
// subscribe for say-requests; forwarding turns into agent input and
// projecting agent replies into speech both happen in this processor, so the
// conversation is journaled, replayable, and independent of any one client's
// lifetime.

import { z } from "zod";
import { defineProcessorContract } from "../streams/stream-processor.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";

export const VOICE_AGENT_PATH_PREFIX = "/agents/voice/";

export function isVoiceAgentPath(agentPath: string): boolean {
  return agentPath.startsWith(VOICE_AGENT_PATH_PREFIX);
}

/**
 * The worker's reply protocol: voice clients read replies aloud, and this
 * sentinel is how the worker declines a turn that needs nothing from it. The
 * voice processor swallows sentinel replies instead of requesting speech.
 */
export const VOICE_WORKER_IDLE_REPLY = "(idle)";

export const VoiceProcessorContract = defineProcessorContract({
  slug: "voice",
  version: "0.1.0",
  description:
    "Multiplexes a realtime voice conversation with this agent: forwards transcribed user turns into agent input and projects agent replies into say-requests for voice clients.",
  stateSchema: z.object({
    /** Completed user turns seen so far (speech + text + tool-call). */
    turnCount: z.number().optional(),
    /** Say-requests projected so far. */
    sayRequestCount: z.number().optional(),
  }),
  events: {
    "events.iterate.com/voice/user-turn-transcribed": {
      description:
        "A realtime voice client completed transcribing one user turn (or received one typed/tool-call turn) and handed it to the worker lane.",
      payloadSchema: z.object({
        transcript: z.string(),
        origin: z.enum(["speech", "text", "tool-call"]),
      }),
    },
    "events.iterate.com/voice/assistant-utterance-completed": {
      description:
        "Audit fact appended by the voice client: what the realtime voice assistant said out loud for one response.",
      payloadSchema: z.object({
        text: z.string(),
      }),
    },
    "events.iterate.com/voice/say-requested": {
      description:
        "The worker agent produced a reply that voice clients should relay out loud as a [worker report].",
      payloadSchema: z.object({
        message: z.string(),
        /** Offset of the agents/web-message-sent event this projects. */
        workerReplyOffset: z.number(),
      }),
    },
    "events.iterate.com/voice/report-suppressed": {
      description:
        "Audit fact appended by the voice client: the voice model judged a worker report redundant and stayed silent (no_comment).",
      payloadSchema: z.object({
        sayRequestedOffset: z.number().optional(),
      }),
    },
  },
  processorDeps: [AgentProcessorContract],
  consumes: [
    "events.iterate.com/voice/user-turn-transcribed",
    "events.iterate.com/agents/web-message-sent",
  ],
  emits: ["events.iterate.com/agent/input-added", "events.iterate.com/voice/say-requested"],
});

export type VoiceProcessorState = z.infer<typeof VoiceProcessorContract.stateSchema>;
