// A stream-processor-backed domain object in project userspace: the guestbook
// state is `reduce` run over the durable events on the project stream at
// /guestbook, by the SAME machinery that runs the platform's own domain
// objects (agents, repos, schedulers — `iterate/processors`). Contrast
// CounterApp in the repo root's worker.ts, which keeps its number in Durable
// Object storage, and the tanstack todo app, which keeps rows in its own
// SQLite: this state is a disposable cache — delete it and replay rebuilds
// it, and every consequential outcome is an event you can read back.
//
// GuestbookApp in guestbook-app.ts is the hosting half: a Durable Object
// registry over an itx-dialed stream handle, woken by the durable wake
// subscription the creation batch (guestbook-ref.ts) configures.
import { z } from "zod";
import {
  defineProcessorContract,
  PLATFORM_STREAM_EVENTS,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "iterate/processors";

export { guestbookAppRef, guestbookCreationEvents, guestbookStreamPath } from "./guestbook-ref.ts";

export const GuestbookProcessorContract = defineProcessorContract({
  slug: "guestbook",
  version: "0.1.0",
  description:
    "Reduces guestbook signatures on /guestbook and emits a milestone fact every five entries.",
  stateSchema: z.object({
    birthCertificate: guestbookBirthCertificateSchema().nullable().default(null).meta({
      description:
        "Existence marker: null until guestbook/created reduces. No milestone is emitted before it.",
    }),
    entries: z
      .array(
        z.object({
          name: z.string().meta({ description: "The signer's name, as signed." }),
          message: z.string().meta({ description: "The signer's message, as signed." }),
          signedAt: z.string().meta({
            description:
              "ISO timestamp copied from the entry-signed event's createdAt stamp — reduce " +
              "never reads the wall clock, so a replay rebuilds identical state.",
          }),
        }),
      )
      .default([])
      .meta({ description: "Every signature in stream order. Append-only." }),
    lastMilestone: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .meta({
        description:
          "The highest milestone-reached count this state has absorbed; the at-head pass " +
          "appends only thresholds above it.",
      }),
  }),
  events: {
    "events.iterate.com/guestbook/created": {
      description:
        "The guestbook exists: its birth certificate, the first event in its domain history. " +
        "Appended (idempotency-keyed) by whoever signs first.",
      payloadSchema: guestbookBirthCertificateSchema(),
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
        name: z.string().trim().min(1).meta({ description: "The signer's name." }),
        message: z.string().trim().min(1).meta({ description: "The message they left." }),
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
        "The entry count crossed a multiple of five. Emitted by the guestbook processor at the " +
        "head of the stream, idempotency-keyed by the count so redeliveries, revivals, and " +
        "replays collapse to one fact.",
      payloadSchema: z.object({
        count: z
          .number()
          .int()
          .positive()
          .meta({ description: "The entry count that was reached — a positive multiple of five." }),
      }),
      examples: [
        {
          description: "The fifth signature landed.",
          payload: { count: 5 },
        },
      ],
    },
  },
  // Required by `{ recovery: true }` (see guestbook-app.ts): a recovery-wired
  // contract must consume the platform revival fact.
  processorDeps: [PLATFORM_STREAM_EVENTS],
  consumes: [
    "events.iterate.com/guestbook/created",
    "events.iterate.com/guestbook/entry-signed",
    "events.iterate.com/guestbook/milestone-reached",
    "events.iterate.com/stream/processor-revived",
  ],
  emits: ["events.iterate.com/guestbook/milestone-reached"],
});
export type GuestbookProcessorContract = typeof GuestbookProcessorContract;

export type GuestbookState = z.output<typeof GuestbookProcessorContract.stateSchema>;

/**
 * The guestbook processor. HOW IT WORKS, end to end:
 *
 * Signatures arrive as `guestbook/entry-signed` events (GuestbookApp's `sign`
 * verb appends them, prefixed by the idempotency-keyed creation batch). The
 * pure `reduce` switch projects them into `state.entries`; timestamps come
 * from each event's own `createdAt` stamp, never the wall clock, so replaying
 * the stream from offset zero rebuilds byte-identical state.
 *
 * The one side effect lives in `processEvent`: when the processor is caught
 * up to the head of the stream and the entry count has crossed a multiple of
 * five that `state.lastMilestone` has not absorbed, it appends one
 * `guestbook/milestone-reached` fact per crossed threshold. That append is
 * derived from the reduced state — not from any single event — so it runs in
 * the background: if this attempt is lost, any later at-head pass re-derives
 * it, and the stable idempotency keys (`milestone:<count>`) collapse the
 * duplicates. The emitted fact comes back through the processor's own
 * subscription, reduces into `lastMilestone`, and the loop closes.
 *
 * If an eviction kills the isolate while a milestone append is still owed,
 * the recovery keepalive wired in guestbook-app.ts (`{ recovery: true }`)
 * appends `stream/processor-revived`; its ordinary delivery lands an at-head
 * `processEvent` turn in the fresh incarnation, which re-derives the milestone
 * from state. That is the whole recovery story — no bookkeeping outside the
 * stream.
 */
export class GuestbookProcessor extends StreamProcessor<GuestbookProcessorContract> {
  readonly contract = GuestbookProcessorContract;

  // The guestbook has no per-event consequences (nothing depends on seeing
  // one particular event exactly once), so there is no per-event switch —
  // the whole hook is the state-derived pass at head.
  protected override processEvent(args: ProcessEventArgs<GuestbookProcessorContract>): undefined {
    const { append, delivery, runInBackground, state } = args;
    // Derive milestones from the reduced state AT HEAD, never from
    // event-time state: a replay redelivers every historical event, and only
    // the at-head state has absorbed the milestones already on the stream.
    // One fact per crossed threshold, even when catch-up lands past several
    // at once (routine while the worker cold-builds).
    if (!delivery.caughtUp || state.birthCertificate === null) return;
    const reached = Math.floor(state.entries.length / 5) * 5;
    if (reached <= state.lastMilestone) return;
    const missed: number[] = [];
    for (let count = state.lastMilestone + 5; count <= reached; count += 5) missed.push(count);
    // Background, not blocking: a lost attempt is re-derived by any later
    // at-head pass over the same state (the recovery keepalive guarantees
    // one), and the stable idempotency keys — count only, no event bound —
    // collapse the appends across redeliveries, revivals, and replays.
    runInBackground(async () => {
      await append(
        ...missed.map((count) => ({
          type: "events.iterate.com/guestbook/milestone-reached" as const,
          payload: { count },
          idempotencyKey: this.idempotencyKey(`milestone:${count}`),
        })),
      );
    });
  }

  protected override reduce(args: ReduceArgs<GuestbookProcessorContract>) {
    const { event, state } = args;
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
}

/**
 * The birth certificate — the ONE schema the contract uses twice (the
 * `guestbook/created` payload and the state's existence marker), so it lives
 * in this hoisted function instead of inline.
 */
function guestbookBirthCertificateSchema() {
  return z.object({
    config: z
      .object({
        title: z.string().meta({ description: "Display title the guestbook page renders." }),
      })
      .meta({ description: "Configuration chosen at creation." }),
  });
}
