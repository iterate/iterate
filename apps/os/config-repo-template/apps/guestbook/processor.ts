// Userspace stream processor: reduces guestbook signatures on the project stream
// at /guestbook. Style matches the agent processor — inline contract schemas,
// long switch reduce/processEvent, no event-type constants.
import { z } from "zod";
import {
  defineProcessorContract,
  PLATFORM_STREAM_EVENTS,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorState,
} from "iterate/processors";

export const GuestbookProcessorContract = defineProcessorContract({
  slug: "guestbook",
  version: "0.1.0",
  description:
    "Reduces guestbook signatures on /guestbook and emits a milestone fact every five entries.",
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
    lastMilestone: z.number().int().nonnegative().default(0).meta({
      description: "Highest multiple-of-five entry count already journaled as milestone-reached.",
    }),
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
    "events.iterate.com/guestbook/milestone-reached": {
      description:
        "The entry count crossed a multiple of five. Emitted at-head from reduced state, " +
        "idempotency-keyed by count so redeliveries and refolds collapse to one fact.",
      payloadSchema: z.object({
        count: z
          .number()
          .int()
          .positive()
          .meta({ description: "Entry count at the milestone (5, 10, 15, …)." }),
      }),
      examples: [
        {
          description: "The fifth signature landed.",
          payload: { count: 5 },
        },
        {
          description: "Catch-up past ten signatures emits the tenth milestone.",
          payload: { count: 10 },
        },
      ],
    },
  },
  // Required by `{ recovery: true }` on the host.
  processorDeps: [PLATFORM_STREAM_EVENTS],
  consumes: [
    "events.iterate.com/guestbook/created",
    "events.iterate.com/guestbook/entry-signed",
    "events.iterate.com/guestbook/milestone-reached",
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: ["events.iterate.com/guestbook/milestone-reached"],
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
        return {
          ...state,
          entries: [...state.entries, { ...event.payload, signedAt: event.createdAt }],
        };
      }
      case "events.iterate.com/guestbook/milestone-reached": {
        return {
          ...state,
          lastMilestone: Math.max(state.lastMilestone, event.payload.count),
        };
      }
      default:
        return state;
    }
  }

  protected override processEvent(
    args: ProcessEventArgs<typeof GuestbookProcessorContract>,
  ): undefined {
    const { blockProcessorWhile, delivery, state } = args;

    // State-derived side effects only: milestones are computed from the full
    // reduced entry list at head, never from a single event. Per-event work is
    // none — signing is an external append, not a processor consequence.
    if (!delivery.caughtUp) return;
    if (state.birthCertificate === null) return;

    const reached = Math.floor(state.entries.length / 5) * 5;
    if (reached <= state.lastMilestone) return;

    const missed: number[] = [];
    for (let count = state.lastMilestone + 5; count <= reached; count += 5) {
      missed.push(count);
    }

    // At-least-once milestone facts: cursor must not advance past the triggering
    // delivery until the idempotent appends land (or redelivery will re-emit).
    // Named function = the reason argument (see agent style notes).
    const { append } = args;
    const processor = this;
    blockProcessorWhile(async function appendMilestoneFactsFromReducedEntryCount() {
      // `as const` on `type` keeps the mapped array a ConsumedInput union member
      // rather than `{ type: string }` — without it append() rejects the event
      // as untyped stream input. buildEvent cannot be used here without a
      // circular contract import at each map step.
      await append(
        ...missed.map((count) => ({
          type: "events.iterate.com/guestbook/milestone-reached" as const,
          payload: { count },
          idempotencyKey: processor.idempotencyKey(`milestone:${count}`),
        })),
      );
    });
  }
}
