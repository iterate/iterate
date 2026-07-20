// A stream-processor-backed domain object in project userspace: the guestbook
// is a fold of durable events on the project stream at /guestbook, processed
// by the SAME machinery that runs the platform's own domain objects
// (agents, repos, schedulers — `iterate/processors`). Contrast CounterApp in
// the repo root's worker.ts, which keeps its number in Durable Object
// storage, and the tanstack todo app, which keeps rows in its own SQLite:
// this state is a disposable cache of `reduce` over the journal — delete it
// and replay rebuilds it, and every consequential outcome is an event you
// can read back.
//
// GuestbookApp in guestbook-app.ts is the hosting half: a Durable Object
// registry over an itx-dialed stream handle, woken by the durable wake
// subscription the creation batch (guestbook-ref.ts) configures.
import { z } from "zod";
import {
  defineProcessorContract,
  PLATFORM_STREAM_EVENTS,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  StreamProcessor,
} from "iterate/processors";

export { guestbookAppRef, guestbookCreationEvents, guestbookStreamPath } from "./guestbook-ref.ts";

export const GuestbookProcessorContract = defineProcessorContract({
  slug: "guestbook",
  version: "0.1.0",
  description:
    "Folds guestbook signatures on /guestbook and emits a milestone fact every five entries.",
  stateSchema: z.object({
    birthCertificate: z
      .object({ config: z.object({ title: z.string() }) })
      .nullable()
      .default(null),
    entries: z
      .array(z.object({ name: z.string(), message: z.string(), signedAt: z.string() }))
      .default([]),
    lastMilestone: z.number().int().nonnegative().default(0),
  }),
  events: {
    "events.iterate.com/guestbook/created": {
      description:
        "The guestbook exists: its birth certificate, the first event in its domain history. Appended (idempotency-keyed) by whoever signs first.",
      payloadSchema: z.object({ config: z.object({ title: z.string() }) }),
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
  },
  // Required by `{ recovery: true }` (see guestbook-app.ts): a recovery-wired
  // contract must consume the platform revival fact.
  processorDeps: [PLATFORM_STREAM_EVENTS],
  consumes: [
    "events.iterate.com/guestbook/created",
    "events.iterate.com/guestbook/entry-signed",
    "events.iterate.com/guestbook/milestone-reached",
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: ["events.iterate.com/guestbook/milestone-reached"],
});

export type GuestbookFoldState = z.infer<typeof GuestbookProcessorContract.stateSchema>;

export class GuestbookProcessor extends StreamProcessor<typeof GuestbookProcessorContract> {
  readonly contract = GuestbookProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof GuestbookProcessorContract>["reduce"]>[0]) {
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
  }: Parameters<StreamProcessor<typeof GuestbookProcessorContract>["processEvent"]>[0]): undefined {
    // At-head reconcile: derive milestones from the WHOLE fold, never from
    // event-time state — a refold replays every historical event, and only
    // the at-head state has absorbed the milestones already journaled. One
    // fact per crossed threshold, even when catch-up lands past several at
    // once (routine while the worker cold-builds); the stable idempotency
    // keys (count folded in, no event bound) make the appends collapse
    // across redeliveries, revivals, and refolds.
    if (!delivery.caughtUp || state.birthCertificate === null) return;
    const reached = Math.floor(state.entries.length / 5) * 5;
    if (reached <= state.lastMilestone) return;
    const missed: number[] = [];
    for (let count = state.lastMilestone + 5; count <= reached; count += 5) missed.push(count);
    blockProcessorWhileCaughtUp(async () => {
      await append(
        ...missed.map((count) => ({
          type: "events.iterate.com/guestbook/milestone-reached" as const,
          payload: { count },
          idempotencyKey: this.idempotencyKey(`milestone:${count}`),
        })),
      );
    });
  }
}
