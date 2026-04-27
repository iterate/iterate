import type { StreamPath } from "@iterate-com/events-contract";

export { buildAgentWebSocketCallbackUrl } from "~/lib/events-urls.ts";

/**
 * Agents SDK kebab-case URL segment for the `IterateAgent` Durable Object
 * class. Used both when creating subscriptions that target it and when
 * composing its debug URLs.
 */
export const ITERATE_AGENT_CLASS = "iterate-agent";

/**
 * Slug used for every `subscription/configured` event that subscribes the
 * `IterateAgent` to a stream. Intentionally constant: Events upserts
 * subscriptions by `slug`, so reusing the same slug replaces the old
 * subscription in place instead of stacking up dead ones.
 */
export const ITERATE_AGENT_SUBSCRIPTION_SLUG = "iterate-agent";

/**
 * Agents SDK kebab-case URL segment for the `ChildStreamAutoSubscriber` class.
 */
export const CHILD_STREAM_AUTO_SUBSCRIBER_CLASS = "child-stream-auto-subscriber";

/**
 * Slug used for the `subscription/configured` event that attaches the
 * `ChildStreamAutoSubscriber` to a prefix stream. Like
 * {@link ITERATE_AGENT_SUBSCRIPTION_SLUG}, stable across reinstalls so
 * calling `installProcessor` twice replaces the subscription in place.
 */
export const CHILD_STREAM_AUTO_SUBSCRIBER_SUBSCRIPTION_SLUG = "child-stream-auto-subscriber";

/**
 * Derive a deterministic Durable Object instance name from a stream path so
 * re-creating an agent at the same path always hits the same DO (and different
 * paths always hit different DOs). Must be URL-path-safe because it's
 * interpolated into `/agents/<class>/<instance>`.
 *
 * - `/`           → `root`
 * - `/jonas`      → `jonas`
 * - `/jonas/abc`  → `jonas-abc`
 * - `/a/b.c!/d`   → `a-b-c-d`
 */
export function streamPathToAgentInstance(streamPath: StreamPath): string {
  const kebab = streamPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab.length === 0 ? "root" : kebab;
}
