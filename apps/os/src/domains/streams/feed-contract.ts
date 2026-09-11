import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import {
  AgentUiStateSchema,
  initialAgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { FeedItemPublication } from "@iterate-com/ui/components/events/feed-publication";
import {
  AgentProcessorContract,
  AgentRuntimeTransition,
} from "../agents/agent-processor-contract.ts";
import { CoreProcessorContract } from "./core-processor-contract.ts";

const FeedLiveStateBase = z.strictObject({
  /** Source lifetime whose publication offsets the browser must mirror; null until its checkpoint loads. */
  streamId: z.uuid().nullable(),
  /** Mirror this publication before displaying the snapshot, so settled rows replace live activity. */
  publicationOffset: z.number().int().nonnegative(),
  runtimeChange: AgentRuntimeTransition.optional(),
});
export const FeedLiveState = z.discriminatedUnion("previewStatus", [
  FeedLiveStateBase.extend({
    previewStatus: z.enum(["available", "shortened"]),
    agent: z.strictObject({
      live: AgentUiStateSchema.shape.live,
      queuedUserMessages: AgentUiStateSchema.shape.queuedUserMessages,
      presence: AgentUiStateSchema.shape.presence,
      tokenUsage: AgentUiStateSchema.shape.tokenUsage,
    }),
  }),
  FeedLiveStateBase.extend({
    /** The complete presentation exceeded the live-message budget; durable history is unchanged. */
    previewStatus: z.literal("omitted"),
    agent: z.null(),
  }),
]);
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
    "events.iterate.com/feed/item-published": {
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
  emits: ["events.iterate.com/feed/item-published"],
});
export type FeedProcessorContract = typeof FeedProcessorContract;
