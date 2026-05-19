import { VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE } from "@iterate-com/shared/stream-processors/voice-agent/contract";
import type { StreamPath } from "@iterate-com/shared/streams/types";
import {
  type AgentPresetEvent,
  DEFAULT_AGENT_LLM_PROVIDER,
  defaultAgentSetupEvents,
  defaultAgentSystemPrompt,
} from "~/domains/agents/agent-presets.ts";

export const VOICE_AGENT_AGENT_PATH_PREFIX = "/agents/voice";

export function isVoiceAgentPath(agentPath: string): boolean {
  return (
    agentPath === VOICE_AGENT_AGENT_PATH_PREFIX ||
    agentPath.startsWith(`${VOICE_AGENT_AGENT_PATH_PREFIX}/`)
  );
}

export function voiceAgentCodeAgentSetupEvents(input: {
  baseEvents?: readonly AgentPresetEvent[];
  streamPath: StreamPath;
}): AgentPresetEvent[] {
  const systemPrompt = voiceAgentCodeAgentSystemPrompt(input.streamPath);
  const baseEvents =
    input.baseEvents ?? defaultAgentSetupEvents(DEFAULT_AGENT_LLM_PROVIDER, input.streamPath);

  let replacedSystemPrompt = false;
  const events = baseEvents.map((event) => {
    if (event.type !== "events.iterate.com/agent/system-prompt-updated") {
      return {
        payload: event.payload,
        type: event.type,
      };
    }
    replacedSystemPrompt = true;
    return {
      payload: {
        ...event.payload,
        systemPrompt,
      },
      type: event.type,
    };
  });

  if (!replacedSystemPrompt) {
    events.push({
      payload: { systemPrompt },
      type: "events.iterate.com/agent/system-prompt-updated",
    });
  }

  return events;
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
    "The text you append should be the exact caller-facing thing the voice operator should say next, not private commentary about what you are doing.",
    "If you need more information before you can do the work, append a concise clarifying question for the voice operator to ask the caller using that same event shape. For example: 'What occupation should I put on your profile?'",
    "For voice-agent streams, do not use ctx.chat.sendMessage for responses. The realtime voice model cannot consume chat responses. It consumes the voice-agent text input events you append to the stream.",
    "Keep voice-facing responses concise, directly speakable, and useful while the caller is waiting.",
  ].join("\n");
}
