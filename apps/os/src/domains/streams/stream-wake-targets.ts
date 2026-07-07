// Derived stream subscriptions.
//
// A stream's first-party processors are NOT configuration: they are a pure
// function of facts the stream already holds, so no subscription-configured
// event ever records them. Two derivation rules cover everything:
//
// 1. RESIDENTS — the stream's path names its domain, and the domain names the
//    observer processors that must see every append (they consume other
//    processors' events, so no single event type can address them). The root
//    stream is the project processor's; agent streams belong to the agent
//    processor family; `/integrations/slack` is the webhook router's.
//
// 2. WAKEABLE NAMESPACES — actor processors are driven purely by their own
//    event vocabulary (`events.iterate.com/<slug>/…`), so appending one of
//    their owned events IS the subscription: the moment a `repo/…`,
//    `capability-host/…`, or `secret/…` event lands on a stream, that
//    processor becomes one of the stream's wake targets, forever (the core
//    reducer folds the namespace into `wakeableNamespaces`, so the set is
//    rebuilt from the journal like all other core state).
//
// Every derived target is hosted by the Durable Object of its kind at the
// STREAM'S OWN coordinates — the same (projectId, path) name, a different
// namespace binding — which is why nothing beyond the slug needs storing.
// Configured `worker` subscribers (userspace) are the one genuinely
// non-derivable subscription kind and keep their event-sourced config; see
// `core-processor-contract.ts`.
//
// The slugs below are string literals so the Stream Durable Object's worker
// never bundles the domain contract modules; `stream-wake-targets.test.ts`
// cross-checks them against the real contracts.

import { isSlackAgentPath, SLACK_INTEGRATION_STREAM_PATH } from "../integrations/utils.ts";

/**
 * The Durable Object namespaces a stream may dial as a derived subscriber
 * host. Every one is addressed by the stream's own Durable Object name; only
 * the binding differs.
 */
export type WakeableDurableObjectKind = "agent" | "capability-host" | "project" | "repo" | "secret";

/**
 * One derived subscriber: a processor slug plus the Durable Object kind that
 * hosts it. The subscription key is always `${streamDurableObjectName}#${slug}`.
 */
export type DerivedStreamProcessor = {
  slug: string;
  kind: WakeableDurableObjectKind;
};

/**
 * Event-namespace segment → hosting Durable Object kind, for the actor
 * processors woken by their own vocabulary (rule 2 above). Deliberately NOT
 * every processor: observers (project, agent family, slack router) react to
 * events they do not own, so they are path residents instead — deriving them
 * from event types would either miss their wakes or dial spurious Durable
 * Objects on foreign streams.
 */
export const WAKEABLE_EVENT_NAMESPACE_KINDS: Record<string, WakeableDurableObjectKind> = {
  "capability-host": "capability-host",
  repo: "repo",
  secret: "secret",
};

const EVENT_TYPE_NAMESPACE_PATTERN = /^events\.iterate\.com\/([^/]+)\//;

/**
 * The wakeable namespace segment of an event type, or undefined when the type
 * is not an `events.iterate.com/…` type or its namespace has no derived host
 * (foreign/vendor event types are facts with no wake target).
 */
export function wakeableEventNamespace(eventType: string): string | undefined {
  const namespace = EVENT_TYPE_NAMESPACE_PATTERN.exec(eventType)?.[1];
  if (namespace === undefined) return undefined;
  return namespace in WAKEABLE_EVENT_NAMESPACE_KINDS ? namespace : undefined;
}

/**
 * The observer processors resident on a stream by virtue of its path (rule 1
 * above). Global streams (`projectId: null`) have no residents: they are
 * capture/directory streams read imperatively, never processor-driven.
 */
export function residentStreamProcessors(input: {
  projectId: string | null;
  path: string;
}): DerivedStreamProcessor[] {
  if (input.projectId === null) return [];
  if (input.path === "/") return [{ slug: "project", kind: "project" }];
  if (input.path === SLACK_INTEGRATION_STREAM_PATH) return [{ slug: "slack", kind: "project" }];
  // Strictly below /agents: the bare `/agents` collection stream only carries
  // child-stream announcements and is not an agent Durable Object path.
  if (input.path.startsWith("/agents/")) {
    return [
      { slug: "agent", kind: "agent" },
      // Both LLM provider processors live on every agent stream; only the one
      // matching the agent's selected llmProvider answers llm-request-requested.
      { slug: "cloudflare-ai", kind: "agent" },
      { slug: "openai-ws", kind: "agent" },
      ...(isSlackAgentPath(input.path)
        ? [{ slug: "slack-agent", kind: "agent" } satisfies DerivedStreamProcessor]
        : []),
    ];
  }
  return [];
}

/**
 * All derived subscribers for a stream: path residents plus every wakeable
 * namespace the journal has seen, deduped by slug (a resident whose namespace
 * also appears folds into one entry).
 */
export function derivedStreamProcessors(input: {
  projectId: string | null;
  path: string;
  wakeableNamespaces: readonly string[];
}): DerivedStreamProcessor[] {
  const targets = new Map<string, DerivedStreamProcessor>();
  for (const resident of residentStreamProcessors(input)) targets.set(resident.slug, resident);
  for (const namespace of input.wakeableNamespaces) {
    const kind = WAKEABLE_EVENT_NAMESPACE_KINDS[namespace];
    if (kind === undefined || targets.has(namespace)) continue;
    targets.set(namespace, { slug: namespace, kind });
  }
  return [...targets.values()];
}
