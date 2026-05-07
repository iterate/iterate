export {
  buildAgentChatStreamProcessorRunnerWebSocketCallbackUrl,
  buildAgentStreamProcessorRunnerWebSocketCallbackUrl,
  buildAgentWebSocketCallbackUrl,
  buildCloudflareAiStreamProcessorRunnerWebSocketCallbackUrl,
  buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl,
  buildOpenAiWsStreamProcessorRunnerWebSocketCallbackUrl,
} from "~/lib/events-urls.ts";

export const AGENT_CHAT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG =
  "agent-chat-stream-processor-runner";
export const AGENT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG = "agent-stream-processor-runner";
export const CLOUDFLARE_AI_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG =
  "cloudflare-ai-stream-processor-runner";
export const CODEMODE_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG =
  "codemode-stream-processor-runner";
export const OPENAI_WS_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG =
  "openai-ws-stream-processor-runner";

/**
 * Agents SDK kebab-case URL segment for the `ChildStreamAutoSubscriber` class.
 */
export const CHILD_STREAM_AUTO_SUBSCRIBER_CLASS = "child-stream-auto-subscriber";

/**
 * Slug used for the `subscription/configured` event that attaches the
 * `ChildStreamAutoSubscriber` to a prefix stream. Stable across reinstalls so
 * calling `installProcessor` twice replaces the subscription in place instead
 * of stacking duplicate websocket subscriptions.
 */
export const CHILD_STREAM_AUTO_SUBSCRIBER_SUBSCRIPTION_SLUG = "child-stream-auto-subscriber";
