import { VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE } from "@iterate-com/shared/stream-processors/voice-agent/contract";
import type { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import {
  DEFAULT_AGENT_LLM_PROVIDER,
  DEFAULT_OPENAI_AGENT_MODEL,
  configuredAgentSetupEvents,
  defaultAgentSystemPrompt,
} from "~/domains/agents/agent-presets.ts";
import { agentSubscriptionConfiguredEvent } from "~/domains/agents/agent-subscription.ts";

export function voiceAgentCodeAgentEvents(input: {
  projectId: string;
  streamPath: StreamPath;
}): EventInput[] {
  return [
    ...configuredAgentSetupEvents({
      idempotencyKeyPrefix: `voice-agent-code-agent:setup:${input.projectId}:${input.streamPath}`,
      model: DEFAULT_OPENAI_AGENT_MODEL,
      provider: DEFAULT_AGENT_LLM_PROVIDER,
      runOpts: {},
      systemPrompt: voiceAgentCodeAgentSystemPrompt(input.streamPath),
    }),
    agentSubscriptionConfiguredEvent({
      agentPath: input.streamPath,
      projectId: input.projectId,
    }),
  ];
}

function voiceAgentCodeAgentSystemPrompt(streamPath: StreamPath) {
  return [
    defaultAgentSystemPrompt(streamPath),
    "",
    "## Realtime voice operator support",
    "You are also supporting a realtime voice operator on a phone call with an end user. The voice operator may ask you to investigate, calculate, fetch, edit files, or run code on behalf of the caller.",
    "The voice operator is busy speaking and listening. Do not ask the voice operator to run code. Only you can run code.",
    "When you need to respond to the voice operator, append an authoritative voice-agent text input event on the current stream from codemode:",
    "await ctx.streams.append({ event: { type: '" +
      VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE +
      "', payload: { text: 'Concise speakable response for the voice operator.', source: 'code-agent' } } });",
    "Keep voice-facing responses concise, directly speakable, and useful while the caller is waiting.",
  ].join("\n");
}
