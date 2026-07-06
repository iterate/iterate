import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "../streams/processor-contracts.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { StreamListItem } from "../streams/schemas.ts";

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.1.0",
  description: "Tiny project projection: bootstrap the default repo and project worker.",
  stateSchema: z.object({
    createRequest: z
      .object({
        projectId: z.string(),
        slug: z.string(),
      })
      .nullable()
      .default(null),
    created: z.boolean().default(false),
    onboardingActive: z.boolean().default(false),
    onboardingCompletedAt: z.string().nullable().default(null),
    agents: z.array(StreamListItem).default([]),
    repos: z.array(StreamListItem).default([]),
    secrets: z.array(StreamListItem).default([]),
    streams: z.array(StreamListItem).default([]),
  }),
  events: {
    "events.iterate.com/project/create-requested": {
      description: "A project creation was requested.",
      payloadSchema: z.object({
        onboardingActive: z.boolean().optional(),
        projectId: z.string(),
        slug: z.string(),
      }),
    },
    "events.iterate.com/project/created": {
      description: "The project root was created.",
      payloadSchema: z.object({
        projectId: z.string(),
        slug: z.string(),
      }),
    },
    "events.iterate.com/project/onboarding-completed": {
      description: "The project owner completed the onboarding agent flow.",
      payloadSchema: z.object({
        agentPath: z.string(),
      }),
    },
  },
  consumes: [
    "*",
    "events.iterate.com/project/onboarding-completed",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/stream/created",
    "events.iterate.com/stream/child-stream-created",
  ],
  processorDeps: [CoreProcessorContract, RepoProcessorContract, AgentProcessorContract],
  emits: [
    "events.iterate.com/agent/config-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-provider-selected",
    "events.iterate.com/project/created",
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/stream/subscription-configured",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<ProjectProcessorContract>`,
 * `ConsumedEvent<ProjectProcessorContract>`, `ProcessorEvent<ProjectProcessorContract, T>`.
 */
export type ProjectProcessorContract = typeof ProjectProcessorContract;

/**
 * The project processor's reduced state, inferred from the contract's
 * `stateSchema` — the one definition of the shape. `created` flips when the
 * bootstrap saga lands; the list fields are what the collection `list()`
 * methods read.
 */
export type ProjectProcessorState = ProcessorState<ProjectProcessorContract>;
