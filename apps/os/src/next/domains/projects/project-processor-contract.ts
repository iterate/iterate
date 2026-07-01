import { z } from "zod";
import { defineProcessorContract } from "../streams/stream-processor.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";

const StreamListItem = z.object({
  createdAt: z.string(),
  path: z.string(),
});

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
    agents: z.array(StreamListItem).default([]),
    repos: z.array(StreamListItem).default([]),
    secrets: z.array(StreamListItem).default([]),
    streams: z.array(StreamListItem).default([]),
  }),
  events: {
    "events.iterate.com/project/create-requested": {
      description: "A project creation was requested.",
      payloadSchema: z.object({
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
  },
  consumes: [
    "*",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/stream/created",
    "events.iterate.com/stream/child-stream-created",
  ],
  processorDeps: [CoreProcessorContract, RepoProcessorContract, AgentProcessorContract],
  emits: [
    "events.iterate.com/agent/config-updated",
    "events.iterate.com/agent/llm-provider-selected",
    "events.iterate.com/project/created",
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/stream/subscription-configured",
  ],
});
