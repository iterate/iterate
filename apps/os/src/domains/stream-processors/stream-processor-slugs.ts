import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { StreamPath } from "@iterate-com/shared/streams/types";

export const VOICE_AGENT_PROCESSOR_SLUG = "voice-agent";
// Retired per-provider slugs. Streams created before the unified voice-agent
// processor still hold subscriptions to these; the registry maps them to no-ops.
export const GEMINI_LIVE_VOICE_PROCESSOR_SLUG = "voice-agent/gemini-live";
export const OPENAI_REALTIME_VOICE_PROCESSOR_SLUG = "voice-agent/openai-realtime";
export const GROK_REALTIME_VOICE_PROCESSOR_SLUG = "voice-agent/grok-realtime";

export type StreamProcessorDurableObjectStructuredName = {
  processorSlug: string;
  projectId: string;
  streamPath: StreamPath;
};

export function getStreamProcessorDurableObjectName(
  input: StreamProcessorDurableObjectStructuredName,
) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: input,
  });
}

export function streamProcessorSubscriptionSlug(input: {
  processorSlug: string;
  projectId: string;
  streamPath: StreamPath;
}) {
  return `${input.processorSlug}:${input.projectId}:${input.streamPath}`;
}
