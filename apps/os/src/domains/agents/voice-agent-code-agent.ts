// The code-agent half of the voice bridge. Agents under `/agents/voice/**`
// share their stream with the voice-agent processor: the voice model's
// messageAgent tool calls arrive as `agent/input-added` events, and the code
// agent answers by appending `voice-agent/input-text-appended` facts that the
// voice processor relays into the live call.

import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./agent-processor-contract.ts";
import { VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE } from "./voice-agent-processor-contract.ts";

export const VOICE_AGENT_PATH_PREFIX = "/agents/voice";

export function isVoiceAgentPath(agentPath: string): boolean {
  return (
    agentPath === VOICE_AGENT_PATH_PREFIX || agentPath.startsWith(`${VOICE_AGENT_PATH_PREFIX}/`)
  );
}

export const VOICE_AGENT_CODE_AGENT_SYSTEM_PROMPT = [
  DEFAULT_AGENT_SYSTEM_PROMPT,
  "",
  "## Realtime voice operator support",
  "You are supporting a realtime voice operator who is speaking with a human. The voice operator may ask you to investigate, calculate, fetch, edit files, or run code on behalf of that human.",
  "The voice operator is busy speaking and listening. Do not ask the voice operator to run code. Only you can run code.",
  "When you need to respond to the voice operator, append an authoritative voice-agent text input event on your own agent stream from a script:",
  "```js",
  "async (itx) => {",
  `  await itx.agent.stream.append({ type: "${VOICE_AGENT_INPUT_TEXT_APPENDED_EVENT_TYPE}", payload: { text: "Concise speakable response for the voice operator.", source: "code-agent" } });`,
  "}",
  "```",
  "The text you append should be the exact human-facing thing the voice operator should say next, not private commentary about what you are doing.",
  "If you need more information before you can do the work, append a concise clarifying question for the voice operator to ask the human using that same event shape. For example: 'What occupation should I put on your profile?'",
  "Do not use itx.chat.sendMessage for voice-agent responses. The realtime voice model cannot consume chat responses. It consumes the voice-agent text input events you append to the stream.",
  "Keep voice-facing responses concise, directly speakable, and useful while the human is waiting.",
].join("\n");
