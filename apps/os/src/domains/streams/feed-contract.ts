import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import {
  AgentUiItemSchema,
  AgentUiStateSchema,
  initialAgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  AgentProcessorContract,
  AgentRuntimeTransition,
} from "../agents/agent-processor-contract.ts";
import { CoreProcessorContract } from "./core-processor-contract.ts";

export const FEED_ITEM_PUBLISHED = "events.iterate.com/feed/item-published";

/** Complete immutable revision. Position is retained when a late fact corrects the item. */
export const FeedItemPublication = z.strictObject({
  item: AgentUiItemSchema,
  firstOffset: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative(),
  revisionOffset: z.number().int().nonnegative(),
});
export type FeedItemPublication = z.infer<typeof FeedItemPublication>;

export const FeedLiveState = z.strictObject({
  agent: z.strictObject({
    live: AgentUiStateSchema.shape.live,
    queuedUserMessages: AgentUiStateSchema.shape.queuedUserMessages,
    presence: AgentUiStateSchema.shape.presence,
    tokenUsage: AgentUiStateSchema.shape.tokenUsage,
  }),
  runtimeChange: AgentRuntimeTransition.optional(),
});
/** Current server-rendered activity, queued messages, presence, and agent runtime. */
export type FeedLiveState = z.infer<typeof FeedLiveState>;

export const FeedProcessorContract = defineProcessorContract({
  slug: "feed",
  version: "1.0.0",
  description: "Publishes immutable feed item revisions and current server-owned presentation.",
  stateSchema: z.strictObject({
    agent: AgentUiStateSchema.default(initialAgentUiState),
    runtimeChange: AgentRuntimeTransition.optional(),
    activityStartOffset: z.number().int().nonnegative().default(0),
  }),
  processorDeps: [AgentProcessorContract, CoreProcessorContract],
  events: {
    [FEED_ITEM_PUBLISHED]: {
      description: "A complete renderable feed item revision, with a stable display position.",
      payloadSchema: FeedItemPublication,
    },
  },
  consumes: [
    "*",
    "events.iterate.com/agent/llm-response-chunks",
    "events.iterate.com/stream/connection-opened",
    "events.iterate.com/stream/connection-closed",
  ],
  emits: [FEED_ITEM_PUBLISHED],
});
export type FeedProcessorContract = typeof FeedProcessorContract;
