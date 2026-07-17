// A stream-processor-backed domain object in project userspace: the guestbook
// is a fold of durable events on the project stream at /guestbook, processed
// by the SAME machinery that runs the platform's own domain objects
// (agents, repos, schedulers — `iterate/processors`). Contrast CounterApp in
// worker.ts, which keeps its number in Durable Object storage: this state is
// a disposable cache of `reduce` over the journal — delete it and replay
// rebuilds it, and every consequential outcome is an event you can read back.
//
// The doctrine this follows (birth certificates, monolithic reducer,
// refold-safe side effects) is the platform's stream-processor convention;
// GuestbookApp in worker.ts shows the hosting half: a Durable Object
// registry, an itx-dialed stream handle, and the project worker poking the
// host when guestbook events land.
import { z } from "zod";
import { defineProcessorContract, StreamProcessor } from "iterate/processors";

export const GUESTBOOK_STREAM_PATH = "/guestbook";

/** Stable idempotency key for the one birth append — every signer offers the
 * same birth batch and the stream dedupes it to a single created event. */
export const GUESTBOOK_CREATED_IDEMPOTENCY_KEY = "guestbook/created";

const GuestbookBirthCertificate = z.object({
  config: z.object({ title: z.string() }),
});

const GUESTBOOK_EVENTS = {
  "events.iterate.com/guestbook/created": {
    description:
      "The guestbook exists: its birth certificate, the first event in its domain history. Appended (idempotency-keyed) by whoever signs first.",
    payloadSchema: GuestbookBirthCertificate,
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
      name: z.string().trim().min(1),
      message: z.string().trim().min(1),
    }),
    examples: [
      {
        description: "A visitor left a note.",
        payload: { name: "Ada", message: "Lovely worker you have here." },
      },
    ],
  },
  "events.iterate.com/guestbook/milestone-reached": {
    description:
      "The entry count crossed a multiple of five. Emitted by the guestbook processor from its at-head reconcile, idempotency-keyed by the milestone count so refolds and redeliveries collapse to one fact.",
    payloadSchema: z.object({ count: z.number().int().positive() }),
    examples: [
      {
        description: "The fifth signature landed.",
        payload: { count: 5 },
      },
    ],
  },
};

export const GuestbookProcessorContract = defineProcessorContract({
  slug: "guestbook",
  version: "0.1.0",
  description:
    "Folds guestbook signatures on /guestbook and emits a milestone fact every five entries.",
  stateSchema: z.object({
    birthCertificate: GuestbookBirthCertificate.nullable().default(null),
    entries: z
      .array(z.object({ name: z.string(), message: z.string(), signedAt: z.string() }))
      .default([]),
    lastMilestone: z.number().int().nonnegative().default(0),
  }),
  events: GUESTBOOK_EVENTS,
  consumes: [
    "events.iterate.com/guestbook/created",
    "events.iterate.com/guestbook/entry-signed",
    "events.iterate.com/guestbook/milestone-reached",
  ],
  emits: ["events.iterate.com/guestbook/milestone-reached"],
});

type GuestbookReduceArgs = Parameters<
  StreamProcessor<typeof GuestbookProcessorContract>["reduce"]
>[0];
type GuestbookProcessEventArgs = Parameters<
  StreamProcessor<typeof GuestbookProcessorContract>["processEvent"]
>[0];

export class GuestbookProcessor extends StreamProcessor<typeof GuestbookProcessorContract> {
  readonly contract = GuestbookProcessorContract;

  protected override reduce({ event, state }: GuestbookReduceArgs): GuestbookReduceArgs["state"] {
    switch (event.type) {
      case "events.iterate.com/guestbook/created":
        if (state.birthCertificate !== null) {
          throw new Error("guestbook received more than one created event");
        }
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/guestbook/entry-signed":
        return {
          ...state,
          entries: [...state.entries, { ...event.payload, signedAt: event.createdAt }],
        };
      case "events.iterate.com/guestbook/milestone-reached":
        return {
          ...state,
          lastMilestone: Math.max(state.lastMilestone, event.payload.count),
        };
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhileCaughtUp,
    delivery,
    state,
  }: GuestbookProcessEventArgs): undefined {
    // At-head reconcile: derive milestones from the WHOLE fold, never from
    // event-time state — a refold replays every historical event, and only
    // the at-head state has absorbed the milestones already journaled. The
    // stable idempotency key (count folded in, no event bound) makes the
    // append collapse across redeliveries, revivals, and refolds.
    if (!delivery.caughtUp || state.birthCertificate === null) return;
    const milestone = Math.floor(state.entries.length / 5) * 5;
    if (milestone <= state.lastMilestone) return;
    blockProcessorWhileCaughtUp(async () => {
      await append({
        type: "events.iterate.com/guestbook/milestone-reached",
        payload: { count: milestone },
        idempotencyKey: this.idempotencyKey(`milestone:${milestone}`),
      });
    });
  }
}
