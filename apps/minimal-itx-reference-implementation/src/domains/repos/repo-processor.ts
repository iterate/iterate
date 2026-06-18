import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";

export const RepoProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  description: "Tiny fake repo projection for the ITX reference implementation.",
  stateSchema: z.object({
    initialized: z.boolean().default(false),
  }),
  initialState: { initialized: false },
  events: {
    "events.iterate.com/stream/created": {
      description: "The repo stream exists.",
      payloadSchema: z.looseObject({}),
    },
  },
  consumes: ["events.iterate.com/stream/created"],
  emits: [],
});

export class RepoProcessor extends StreamProcessor<typeof RepoProcessorContract> {
  readonly contract = RepoProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof RepoProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/stream/created":
        return { ...state, initialized: true };
      default:
        return state;
    }
  }
}
