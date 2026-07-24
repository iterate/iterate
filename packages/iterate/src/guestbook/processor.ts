// The guestbook's stream processor: it folds the signatures on the project
// stream at /guestbook into a birth certificate plus an append-only list of
// entries. The reduce is the whole processor — pure fold, no side effects.
import { z } from "zod";
import { defineProcessorContract, StreamProcessor } from "../processors/index.ts";
import type { ProcessorState, ReduceArgs } from "../processors/index.ts";

export const GuestbookProcessorContract = defineProcessorContract({
  slug: "guestbook",
  version: "0.1.0",
  description: "Reduces guestbook signatures on /guestbook.",
  stateSchema: z.object({
    birthCertificate: z
      .object({
        config: z.object({
          title: z.string().meta({ description: "Display title shown on the public page." }),
        }),
      })
      .nullable()
      .default(null)
      .meta({
        description: "Existence marker: null until guestbook/created reduces. Signing requires it.",
      }),
    entries: z
      .array(
        z.object({
          name: z.string().meta({ description: "Signer display name." }),
          message: z.string().meta({ description: "Note left by the signer." }),
          signedAt: z
            .string()
            .meta({ description: "ISO-8601 time from the stream event createdAt." }),
        }),
      )
      .default([])
      .meta({ description: "Signatures in stream order (oldest first)." }),
  }),
  events: {
    "events.iterate.com/guestbook/created": {
      description:
        "The guestbook exists: its birth certificate, the first event in its domain history. " +
        "Appended (idempotency-keyed) by whoever signs first or opens the API.",
      payloadSchema: z.object({
        config: z
          .object({
            title: z.string().meta({ description: "Display title for the guestbook." }),
          })
          .meta({ description: "Initial configuration." }),
      }),
      examples: [
        {
          description: "A guestbook born with its display title.",
          payload: { config: { title: "Guestbook" } },
        },
      ],
    },
    "events.iterate.com/guestbook/entry-signed": {
      description: "Someone signed the guestbook: their name and message.",
      payloadSchema: z.object({
        name: z.string().trim().min(1).meta({ description: "Signer display name." }),
        message: z.string().trim().min(1).meta({ description: "Note left by the signer." }),
      }),
      examples: [
        {
          description: "A visitor left a note.",
          payload: { name: "Ada", message: "Lovely worker you have here." },
        },
      ],
    },
  },
  consumes: ["events.iterate.com/guestbook/created", "events.iterate.com/guestbook/entry-signed"],
  emits: [],
});
export type GuestbookProcessorContract = typeof GuestbookProcessorContract;

export type GuestbookState = ProcessorState<GuestbookProcessorContract>;

export class GuestbookProcessor extends StreamProcessor<GuestbookProcessorContract> {
  readonly contract = GuestbookProcessorContract;

  protected override reduce({ event, state }: ReduceArgs<GuestbookProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/guestbook/created":
        // Idempotency-keyed at the source, but a duplicate that slips through
        // folds to a no-op rather than wedging the frame.
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/guestbook/entry-signed":
        return {
          ...state,
          entries: [...state.entries, { ...event.payload, signedAt: event.createdAt }],
        };
      default:
        return state;
    }
  }
}
