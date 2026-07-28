// The agent-collection CONTRACT: the per-project agent catalog, reduced from
// agent facts copied off the individual agent streams. The collection
// owns ONE event (its own birth); everything else it consumes resolves
// through `processorDeps: [AgentProcessorContract]` — `agent/created` and
// `agent/summary-updated` are the agent processor's vocabulary, never
// re-declared here. The catalog record shapes (`AgentPath`,
// `AgentCatalogRecord`) live in `agent-presence.ts` because they are the
// agents domain's shared vocabulary: the agent processor validates the same
// summary shapes on the source streams, and presentation extends
// `AgentCatalogRecord` into `AgentRecord` — this contract points at that
// single definition rather than forking a copy.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentCatalogRecord, AgentPath } from "./agent-presence.ts";

export const AgentCollectionProcessorContract = defineProcessorContract({
  slug: "agent-collection",
  version: "0.2.0",
  description: "Reduces the project's agent creation and summary facts into its agent database.",
  stateSchema: z.strictObject({
    birthCertificate: z
      .strictObject({})
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until agent-collection/created reduces. The payload is " +
          "empty — the collection's identity is its stream path.",
      }),
    agents: z
      .record(AgentPath, AgentCatalogRecord)
      .default({})
      .meta({
        description:
          "The agent database: one catalog record per agent, keyed by canonical agent path, " +
          "reduced from the copied agent/created and agent/summary-updated facts. " +
          "Timestamps preserve SOURCE-stream chronology, never collection ingest time.",
      }),
    waitingForSinceOffsets: z
      .record(AgentPath, z.number().int().positive())
      .default({})
      .meta({
        description:
          "Per-agent SOURCE-stream offset of the newest waitingFor set, so a delayed " +
          "conditional clear (clearWaitingForThroughOffset) cannot erase a newer wait. " +
          "Technical reducer state — presentation consumers read only `agents`.",
      }),
  }),
  processorDeps: [AgentProcessorContract],
  events: {
    "events.iterate.com/agent-collection/created": {
      description: "Creates the singleton agent collection processor for a project.",
      payloadSchema: z.strictObject({}),
    },
  },
  consumes: [
    "events.iterate.com/agent-collection/created",
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/summary-updated",
  ],
  emits: ["events.iterate.com/agent-collection/created"],
});
export type AgentCollectionProcessorContract = typeof AgentCollectionProcessorContract;

/** The singleton agent collection processor's reduced database state. */
export type AgentCollectionProcessorState = ProcessorState<AgentCollectionProcessorContract>;

/** The one canonical stream path a project's agent collection lives at. */
export const AGENT_COLLECTION_PATH = "/agents";
export const AGENT_COLLECTION_SUBSCRIPTION_KEY = "agent-collection";
export const AGENT_COLLECTION_CREATED_EVENT_TYPE = "events.iterate.com/agent-collection/created";
