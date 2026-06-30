import { z } from "zod";
import { defineProcessorContract } from "../streams/stream-processor.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const RepoProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  description: "Tiny fake repo projection for the ITX reference implementation.",
  stateSchema: z.object({
    artifactName: z.string().nullable().default(null),
    created: z.boolean().default(false),
    defaultBranch: z.string().nullable().default(null),
    initialized: z.boolean().default(false),
    remote: z.string().nullable().default(null),
  }),
  events: {
    "events.iterate.com/repo/create-requested": {
      description: "A repo creation was requested.",
      payloadSchema: z.object({
        projectId: z.string().nullable(),
        path: z.string(),
      }),
    },
    "events.iterate.com/repo/created": {
      description: "The repo was created.",
      payloadSchema: z.object({
        artifactName: z.string(),
        defaultBranch: z.string(),
        path: z.string(),
        projectId: z.string().nullable(),
        remote: z.string(),
      }),
    },
  },
  processorDeps: [CoreProcessorContract],
  consumes: [
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/stream/created",
  ],
  emits: ["events.iterate.com/repo/created"],
});
