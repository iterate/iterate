import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { CoreProcessorContract } from "../streams/engine/processors/core/contract.ts";

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
    "events.iterate.com/repo/create-requested": {
      description: "The project root repo should be created.",
      payloadSchema: z.object({
        projectId: z.string(),
        path: z.string(),
      }),
    },
    "events.iterate.com/repo/created": {
      description: "A project repo was created.",
      payloadSchema: z.object({
        artifactName: z.string(),
        defaultBranch: z.string(),
        path: z.string(),
        projectId: z.string(),
        remote: z.string(),
      }),
    },
  },
  consumes: [
    "*",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-requested",
    "events.iterate.com/repo/created",
  ],
  processorDeps: [CoreProcessorContract],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/stream/subscription-configured",
  ],
});
