// A stream-processor-backed domain object in project userspace: the guestbook
// is a fold of durable events on the project stream at /guestbook, processed
// by the SAME machinery that runs the platform's own domain objects
// (agents, repos, schedulers — `iterate/processors`). Contrast CounterApp in
// worker.ts, which keeps its number in Durable Object storage: this state is
// a disposable cache of `reduce` over the journal — delete it and replay
// rebuilds it, and every consequential outcome is an event you can read back.
//
// GuestbookApp in worker.ts is the hosting half: a Durable Object registry
// over an itx-dialed stream handle, woken by the durable wake subscription
// the creation batch below configures.
import { z } from "zod";
import {
  defineProcessorContract,
  PLATFORM_STREAM_EVENTS,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  StreamProcessor,
  type StreamEventInput,
} from "iterate/processors";
import type { DynamicWorkerRef } from "iterate/sdk";

export const guestbookStreamPath = "/guestbook";

// One declarative ref for the guestbook host, shared by the HTTP route
// (fetchDynamicWorker) and the wake subscription below — the same Durable
// Object either way, addressed by its durableWorkerKey.
export const guestbookAppRef = {
  type: "stateful",
  path: "/",
  className: "GuestbookApp",
  durableWorkerKey: "app-guestbook",
  source: {
    files: { type: "repo", repoPath: "/repos/config" },
    options: { entryPoint: "worker.ts" },
  },
} satisfies DynamicWorkerRef;

/**
 * The guestbook's creation batch: the birth certificate plus the durable
 * WAKE subscription that puts the GuestbookApp Durable Object on the
 * stream's own delivery spine — the platform evaluates the persisted
 * expression (`workers.get(ref).processor.wakeStreamSubscriber`, resolved
 * via the dynamic capability fallback into the app's `processor` getter),
 * performs the wake handshake, and pushes event frames straight into the
 * registry's runner. Same machinery, same lane as the platform's own
 * domain processors. Both events are idempotency-keyed, so every creator
 * (the app's /sign handler, a script, a test) offers this same batch and
 * the stream collapses it to one birth and one subscription.
 */
export function guestbookCreationEvents(): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/guestbook/created",
      payload: { config: { title: "Guestbook" } },
      idempotencyKey: "guestbook/created",
    },
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "app-guestbook#guestbook",
        delivery: {
          mode: "wake",
          expression: ["workers", ["get", guestbookAppRef], "processor", "wakeStreamSubscriber"],
          processorSlug: "guestbook",
        },
      },
      idempotencyKey: "guestbook/subscription",
    },
  ];
}

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
  // The platform's keepalive revival fact: the processor registers with
  // `{ recovery: true }` (see worker.ts), and a recovery-wired contract must
  // consume it — its wake delivery is the guaranteed at-head turn after a
  // revival. The reducer ignores it; the delivery is the point.
  processorDeps: [PLATFORM_STREAM_EVENTS],
  consumes: [
    "events.iterate.com/guestbook/created",
    "events.iterate.com/guestbook/entry-signed",
    "events.iterate.com/guestbook/milestone-reached",
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: ["events.iterate.com/guestbook/milestone-reached"],
});

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
