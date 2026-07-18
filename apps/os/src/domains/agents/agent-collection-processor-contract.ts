import { z } from "zod";
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
  version: "0.1.0",
  description: "Folds the project's agent creation and metadata facts into its agent database.",
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
    "events.iterate.com/agent/metadata-changed",
  ],
  emits: [AGENT_COLLECTION_CREATED_EVENT_TYPE],
});

export type AgentCollectionProcessorContract = typeof AgentCollectionProcessorContract;
/** The singleton agent collection processor's reduced database state. */
export type AgentCollectionProcessorState = ProcessorState<AgentCollectionProcessorContract>;
