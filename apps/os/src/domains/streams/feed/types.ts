import type { RawFeedItemData } from "./projector.ts";

// These are the wire shapes of packages/ui's AgentUi reducer. They live here
// as public structural types because itx-api.generated.ts is deliberately an
// import-free standalone contract; keeping the StreamFeed prefix also makes
// their stability boundary explicit instead of publishing UI-package names.
/** One language-model step represented in the rendered stream feed. */
export type StreamFeedAgentLlmStep = {
  kind: "llm";
  id: string;
  llmRequestOffset: number;
  status: "running" | "done";
  model?: string;
  thinkingText: string;
  responseText: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  outcome?: "completed" | "failed" | "cancelled";
  cancelReason?: "interrupted-by-user-input" | "durable-object-crashed";
  errorMessage?: string;
  startedAtMs: number;
};

/** One code-execution step represented in the rendered stream feed. */
export type StreamFeedAgentCodeStep = {
  kind: "code";
  id: string;
  executionId: string;
  status: "running" | "done";
  code: string;
  result?: unknown;
  errorMessage?: string;
  durationMs?: number;
  success?: boolean;
  outcomeSource?: "durable" | "inferred";
  startedAtMs: number;
  expiresAtMs: number;
};

/** One executable step within an agent activity. */
export type StreamFeedAgentStep = StreamFeedAgentLlmStep | StreamFeedAgentCodeStep;

/** A rendered agent activity and its ordered execution steps. */
export type StreamFeedAgentActivity = {
  kind: "activity";
  id: string;
  status: "running" | "done";
  steps: StreamFeedAgentStep[];
  startedAtMs: number;
  endedAtMs?: number;
  phase?: "llm" | "script";
  phaseStartedAtMs?: number;
};

/** A file attached to a rendered agent message. */
export type StreamFeedAgentFileAttachment = {
  contentType: string;
  filename: string;
  path: string;
  size: number;
  url: string;
};

/** The external service and optional sender that supplied an agent message. */
export type StreamFeedAgentMessageVia = {
  service: "slack" | "telegram" | "agent" | "email" | "github";
  sender?: string;
};

/** A rendered user or assistant message in the stream feed. */
export type StreamFeedAgentMessageItem = {
  kind: "user" | "assistant";
  id: string;
  text: string;
  timestampMs: number;
  files?: StreamFeedAgentFileAttachment[];
  via?: StreamFeedAgentMessageVia;
};

/** A rendered marker indicating that a stream woke. */
export type StreamFeedAgentStreamWakeItem = {
  kind: "stream-woken";
  id: string;
  text: string;
  timestampMs: number;
};

/** A rendered marker announcing a newly created child stream. */
export type StreamFeedAgentChildStreamItem = {
  kind: "child-stream-created";
  id: string;
  childPath: string;
  timestampMs: number;
};

/** A rendered marker indicating that a stream paused or resumed. */
export type StreamFeedAgentStreamPauseItem = {
  kind: "stream-paused" | "stream-resumed";
  id: string;
  text: string;
  reason?: string;
  timestampMs: number;
};

/** Any settled agent-facing item represented in the stream feed. */
export type StreamFeedAgentItem =
  | StreamFeedAgentMessageItem
  | StreamFeedAgentActivity
  | StreamFeedAgentStreamWakeItem
  | StreamFeedAgentChildStreamItem
  | StreamFeedAgentStreamPauseItem;

/** Public metadata announced by an agent processor. */
export type StreamFeedAgentProcessorAnnouncement = {
  slug: string;
  version: string;
  description: string;
  consumes: string[];
  emits: string[];
  ownedEvents: Array<{ type: string; description?: string }>;
};

/** One inbound or outbound processor presence entry. */
export type StreamFeedAgentPresenceEntry = {
  subscriptionKey: string;
  direction: "inbound" | "outbound";
  connected: boolean;
  description?: string;
  processor?: StreamFeedAgentProcessorAnnouncement;
};

/** Accumulated agent token usage plus the latest model report. */
export type StreamFeedAgentTokenUsage = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalReasoningOutputTokens: number;
  lastReport: {
    model: string;
    maxContextTokens: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
};

/** The agent reducer state exposed by the feed live view. */
export type StreamFeedAgentState = {
  live: StreamFeedAgentActivity | null;
  deferredAssistantMessages: StreamFeedAgentMessageItem[];
  queuedUserMessages: StreamFeedAgentMessageItem[];
  eventCount: number;
  presence: StreamFeedAgentPresenceEntry[];
  tokenUsage: StreamFeedAgentTokenUsage;
  statusSinceOffset: number | null;
  provisionalActivities: Record<string, StreamFeedAgentActivity>;
};

/** One settled row in the rendered feed. */
export type StreamFeedItem = {
  localIndex: number;
  kind: string;
  firstOffset: number;
  lastOffset: number;
  eventCount: number;
  data: StreamFeedAgentItem | RawFeedItemData;
};

/** Raw-feed filtering criteria for finite feed reads. */
export type StreamFeedRawFilter = {
  eventTypes: readonly string[] | null;
  components: readonly string[] | null;
  searchQuery: string | null;
  offsetFrom: number | null;
  offsetTo: number | null;
};

/** The two row families a stream-view mode selects from the one feed order. */
export type StreamFeedFilter = {
  agent: { showDebug: boolean; searchQuery: string | null } | null;
  raw: StreamFeedRawFilter | null;
};

/**
 * A finite materialized-feed read. `offset` addresses a dense position in the
 * filtered collection (for virtualization); `beforeLocalIndex` pages backward
 * by stable row identity. They are mutually exclusive.
 */
export type StreamFeedReadInput = {
  offset?: number;
  beforeLocalIndex?: number;
  limit?: number;
  filter?: StreamFeedFilter;
};

/** The durable projection cursor relative to the source stream. */
export type StreamFeedProjectionStatus = {
  acknowledgedThroughOffset: number;
  streamMaxOffset: number;
  caughtUp: boolean;
};

/** One finite page from the materialized rendered feed. */
export type StreamFeedPage = {
  items: StreamFeedItem[];
  /** Count in the filtered collection, not the unfiltered feed table. */
  total: number;
  projection: StreamFeedProjectionStatus;
};

/** Bounded state pushed by `Stream.liveState`; older rows use getFeedItems. */
export type StreamFeedLiveState = {
  agent: StreamFeedAgentState;
  recentItems: StreamFeedItem[];
  /** Total settled rows in the unfiltered materialized feed. */
  itemCount: number;
  paused: { paused: boolean; reason: string | null };
  projection: StreamFeedProjectionStatus;
};
