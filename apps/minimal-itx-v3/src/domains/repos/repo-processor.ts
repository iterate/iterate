import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "../streams/engine/stream-processor.ts";

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
  initialState: {
    artifactName: null,
    created: false,
    defaultBranch: null,
    initialized: false,
    remote: null,
  },
  events: {
    "events.iterate.com/repo/create-requested": {
      description: "A repo creation was requested.",
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/repo/created": {
      description: "The repo was created.",
      payloadSchema: z.looseObject({
        artifactName: z.string(),
        defaultBranch: z.string(),
        remote: z.string(),
      }),
    },
    "events.iterate.com/stream/created": {
      description: "The repo stream exists.",
      payloadSchema: z.looseObject({}),
    },
  },
  consumes: [
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/stream/created",
  ],
  emits: [],
});

export class RepoProcessor extends StreamProcessor<typeof RepoProcessorContract> {
  readonly contract = RepoProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof RepoProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/repo/created":
        return {
          ...state,
          artifactName: event.payload.artifactName,
          created: true,
          defaultBranch: event.payload.defaultBranch,
          remote: event.payload.remote,
        };
      case "events.iterate.com/stream/created":
        return { ...state, initialized: true };
      default:
        return state;
    }
  }

  protected override processEvent(): undefined {}
}
