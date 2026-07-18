import { z } from "zod";
import { AGENT_SUMMARY_UPDATED_EVENT_TYPE } from "@iterate-com/shared/agent-events";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentCatalogRecord, AgentPath } from "./agent-presence.ts";

export const AGENT_COLLECTION_PATH = "/agents";
export const AGENT_COLLECTION_CREATED_EVENT_TYPE = "events.iterate.com/agent-collection/created";

/** The agent catalogue is this processor's reduced state. */
const AgentDatabase = z.strictObject({
  birthCertificate: z.strictObject({}).nullable().default(null),
  agents: z.record(AgentPath, AgentCatalogRecord).default({}),
  /** Source-agent offsets are technical reducer state for conditional waiting
   * clears; presentation consumers use only `agents`. */
  waitingForSinceOffsets: z.record(AgentPath, z.number().int().positive()).default({}),
});

export const AgentCollectionProcessorContract = defineProcessorContract({
  slug: "agent-collection",
  version: "0.2.0",
  description: "Folds the project's agent creation and summary facts into its agent database.",
  stateSchema: AgentDatabase,
  events: {
    [AGENT_COLLECTION_CREATED_EVENT_TYPE]: {
      description: "Creates the singleton agent collection processor for a project.",
      payloadSchema: z.strictObject({}),
      examples: [{ description: "Create the project agent collection.", payload: {} }],
    },
  },
  processorDeps: [AgentProcessorContract],
  consumes: [
    AGENT_COLLECTION_CREATED_EVENT_TYPE,
    "events.iterate.com/agent/created",
    AGENT_SUMMARY_UPDATED_EVENT_TYPE,
  ],
  emits: [AGENT_COLLECTION_CREATED_EVENT_TYPE],
});

export type AgentCollectionProcessorContract = typeof AgentCollectionProcessorContract;
/** The singleton agent collection processor's reduced database state. */
export type AgentCollectionProcessorState = ProcessorState<AgentCollectionProcessorContract>;
