import type { StreamPath } from "@iterate-com/events-contract";

export {
  buildAgentStreamProcessorRunnerWebSocketCallbackUrl,
  buildAgentWebSocketCallbackUrl,
  buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl,
  buildWebchatStreamProcessorRunnerWebSocketCallbackUrl,
} from "~/lib/events-urls.ts";

export const AGENT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG = "agent-stream-processor-runner";
export const CODEMODE_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG =
  "codemode-stream-processor-runner";
export const WEBCHAT_STREAM_PROCESSOR_RUNNER_SUBSCRIPTION_SLUG = "webchat-stream-processor-runner";

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

/**
 * Derive a deterministic Durable Object instance name from a stream path so
 * re-creating an agent at the same path always hits the same DO (and different
 * paths always hit different DOs). Must be URL-path-safe because it's
 * interpolated into `/agents/<class>/<instance>`.
 *
 * Uses a hex encoding of the full path instead of a slug so hierarchy
 * separators and literal punctuation cannot collapse into the same instance.
 */
export function streamPathToAgentInstance(streamPath: StreamPath): string {
  const encodedPath = [...new TextEncoder().encode(streamPath)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `stream-${encodedPath}`;
}
