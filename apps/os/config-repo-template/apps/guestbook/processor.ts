// Userspace stream processor: reduces guestbook signatures on the project stream
// at /guestbook. Style matches the agent processor — inline contract schemas,
// long switch reduce/processEvent, no event-type constants.
import { z } from "zod";
import { defineProcessorContract, StreamProcessor, type ProcessorState } from "iterate/processors";

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
        {
          description: "A short thank-you.",
          payload: { name: "Grace", message: "Thanks for the demo." },
        },
      ],
    },
  },
  consumes: ["events.iterate.com/guestbook/created", "events.iterate.com/guestbook/entry-signed"],
  emits: [],
});

export type GuestbookState = ProcessorState<typeof GuestbookProcessorContract>;

export class GuestbookProcessor extends StreamProcessor<typeof GuestbookProcessorContract> {
  readonly contract = GuestbookProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof GuestbookProcessorContract>["reduce"]>[0]): GuestbookState {
    switch (event.type) {
      case "events.iterate.com/guestbook/created": {
        if (state.birthCertificate !== null) {
          throw new Error("guestbook received more than one created event");
        }
        return { ...state, birthCertificate: event.payload };
      }
      case "events.iterate.com/guestbook/entry-signed": {
        if (state.birthCertificate === null) {
          throw new Error("guestbook received an entry before its created event");
        }
        return {
          ...state,
          entries: [...state.entries, { ...event.payload, signedAt: event.createdAt }],
        };
      }
      default:
        return state;
    }
  }
}
