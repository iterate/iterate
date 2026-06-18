import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "@iterate-com/os/src/domains/streams/engine/stream-processor.ts";

export const RepoProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  description: "Tiny fake repo projection for the ITX reference implementation.",
  stateSchema: z.object({
    created: z.boolean().default(false),
    initialized: z.boolean().default(false),
  }),
  initialState: { created: false, initialized: false },
  events: {
    "events.iterate.com/repo/create-requested": {
      description: "A repo creation was requested.",
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/repo/created": {
      description: "The repo was created.",
      payloadSchema: z.looseObject({}),
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
  emits: ["events.iterate.com/repo/created"],
});

export class RepoProcessor extends StreamProcessor<typeof RepoProcessorContract> {
  readonly contract = RepoProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof RepoProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/repo/created":
        return { ...state, created: true };
      case "events.iterate.com/stream/created":
        return { ...state, initialized: true };
      default:
        return state;
    }
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
  }: Parameters<StreamProcessor<typeof RepoProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/repo/create-requested") return;
    blockProcessorWhile(async () => {
      await this.ctx.stream.append({
        event: {
          type: "events.iterate.com/repo/created",
          idempotencyKey: `repo-created:${event.offset}`,
          payload: event.payload,
        },
      });
    });
  }
}
