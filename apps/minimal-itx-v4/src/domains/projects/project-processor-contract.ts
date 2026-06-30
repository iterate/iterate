import { z } from "zod";
import { defineProcessorContract } from "../streams/engine/shared/stream-processors.ts";
import { CoreProcessorContract } from "../streams/engine/processors/core/contract.ts";
import { RepoProcessorContract } from "../repos/repo-processor-contract.ts";

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
  }),
  initialState: { createRequest: null, created: false },
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
    "events.iterate.com/stream/child-stream-created",
  ],
  processorDeps: [CoreProcessorContract, RepoProcessorContract],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/stream/subscription-configured",
  ],
});
