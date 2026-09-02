// core-processor.ts — THE CORE REDUCE: the one processor the context DO reduces INLINE at its commit
// point. Its reduced state is everything the DO needs SYNCHRONOUSLY at its doors, event-sourced from
// the context's own control events and nothing else:
//
//   who this context is       stream/created { projectId, path }            → projectId · path · createdAt
//   which incarnation runs    stream/woken { incarnation }                  → incarnation
//   may appends land          stream/paused { reason } · stream/resumed     → paused        (one `if` in Stream.append)
//   how calls route           capability-table/capability-provided|-revoked → mounts        (route(), every invoke)
//   who is sent each commit   stream/subscription-configured|-removed|
//                             -delivery-halted|-delivery-resumed            → subscriptions (the delivery loop)
//
// ONE reduce, no effects, no verbs — the same `StreamProcessor` class every facet processor is,
// owned by the Stream itself (stream.ts `core()`, reduced inside every commit) because its readers are the append door, the
// dispatcher and the delivery loop, all synchronous. The COMMANDS that append these events live
// beside the code that reads each slice (context/capability-table.ts for mounts,
// stream/subscriptions.ts for rows); the READERS are pure functions over the state. Control is
// ORDINARY EVENTS: `itx.append({ type: 'events.iterate.com/stream/paused', payload: { reason } })`
// pauses, `stream/resumed` resumes — so a POLICY processor (a token-bucket breaker, a quota) runs as
// an ordinary facet and trips the stream by appending `paused` with its reason. Core knows nothing
// about it; e2e/support/sources.ts's BreakerProcessor is that pattern.
//
// created/woken are appended by the DO's CONSTRUCTOR (Stream.appendCreatedAndWokenEvents), synchronously, before any door
// opens — the apps/os shape: the log's first event is the birth certificate, every incarnation's
// first event is its wake record. The platform's own records and the pause/resume pair are exempt
// from pause — a paused stream must always accept its own resume.

import { z } from "zod";
import { createLogger } from "../lib/logs.ts";
import { parse, parseCapabilityPath, type Expression } from "../context/expression.ts";
import { defineProcessorContract } from "./events.ts";
import { StreamProcessor, type ReduceArgs } from "./processor.ts";

const log = createLogger("core");

/** One segment, [A-Za-z0-9_-]: the facet name for a processor, the registry key's tail for a live
 *  callback. */
export const SubscriptionName = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "a subscription name is one segment: [A-Za-z0-9_-]+");

export const CoreContract = defineProcessorContract({
  slug: "core",
  version: "3.0.0", // 3.0.0: ONE core reduce — identity, wake, pause, mounts, subscriptions (the breaker left for a facet)
  description:
    "The context's own state, reduced inline at the commit point: who it is, which incarnation runs, whether appends are paused, the capability mounts every call routes through, and the subscriptions every commit is sent to.",
  stateSchema: z.object({
    /** From the birth certificate (stream/created, offset 1). */
    projectId: z.string().optional(),
    path: z.string().optional(),
    createdAt: z.string().optional(),
    /** From the wake record (stream/woken) — growth across idle is the hibernation tell. */
    incarnation: z.number().optional(),
    paused: z.object({ reason: z.string() }).nullable().default(null),
    /** THE CAPABILITY TABLE: a shadow stack — same-path mounts coexist, newest wins, revoke-by-offset
     *  pops exactly one. The EVENT stores both halves as strings; they are parsed here, once. */
    mounts: z
      .array(
        z.object({
          path: z.array(z.string()),
          target: z.custom<Expression>(() => true),
          /** The mount's identity — the offset of its capability-provided event. */
          providedAtOffset: z.number().int().positive(),
        }),
      )
      .default([]),
    /** THE SUBSCRIPTIONS TABLE: by name; a same-named configure REPLACES (no stack). */
    subscriptions: z
      .record(
        z.string(),
        z.object({
          /** The target, parsed; its terminal is callable with (events, range). */
          target: z.custom<Expression>(() => true),
          /** Event types delivered; absent = every durable event; naming a type opts its ephemerals in. */
          consumes: z.array(z.string()).optional(),
          /** The row's identity — the offset of its subscription-configured event. */
          configuredAtOffset: z.number().int().positive(),
          /** A CURSOR target that exhausted its retries (the loop appended the halted fact). */
          halted: z
            .object({ afterOffset: z.number(), attempts: z.number(), error: z.string().optional() })
            .optional(),
          /** The newest delivery-resumed: the loop applies it once (a seek, an un-halt). */
          resumed: z
            .object({ afterOffset: z.number().optional(), atOffset: z.number() })
            .optional(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/stream/created": {
      description:
        "The birth certificate — the log's first event, appended by the first incarnation's constructor.",
      payloadSchema: z.object({ projectId: z.string(), path: z.string() }),
    },
    "events.iterate.com/stream/woken": {
      description:
        "The wake record — appended by every incarnation's constructor before any door opens.",
      payloadSchema: z.object({ incarnation: z.number() }),
    },
    "events.iterate.com/stream/paused": {
      description: "Refuse every non-control append until resumed.",
      payloadSchema: z.object({ reason: z.string().default("paused") }),
    },
    "events.iterate.com/stream/resumed": { payloadSchema: z.object({}) },
    "events.iterate.com/capability-table/capability-provided": {
      description:
        "Mount a capability at `path` → a `target` expression (string half of the codec — the log stays human-readable; same-path mounts SHADOW, newest wins). That is the whole event. A live stub's mount targets `itx.rpcStubs.get('<path>')`.",
      payloadSchema: z.object({ path: z.string(), target: z.string() }),
    },
    "events.iterate.com/capability-table/capability-revoked": {
      description:
        "Pop exactly the mount created at `providedAtOffset` (what's beneath is restored).",
      payloadSchema: z.object({ providedAtOffset: z.number().int().positive() }),
    },
    "events.iterate.com/stream/subscription-configured": {
      description:
        "Send each committed batch (filtered by `consumes`) to `target`, an itx expression whose terminal is callable with (events, range). Same name REPLACES.",
      payloadSchema: z.object({
        name: SubscriptionName,
        target: z.string(),
        consumes: z.array(z.string()).optional(),
      }),
    },
    "events.iterate.com/stream/subscription-removed": {
      description: "Stop: drop the named subscription (and, for a cursor target, its cursor).",
      payloadSchema: z.object({ name: SubscriptionName }),
    },
    "events.iterate.com/stream/subscription-delivery-halted": {
      description:
        "Appended by the delivery loop: a cursor target failed too many times (or with retryable: false); deliveries stop until a delivery-resumed.",
      payloadSchema: z.object({
        name: SubscriptionName,
        afterOffset: z.number().int().nonnegative(),
        attempts: z.number().int().nonnegative(),
        error: z.string().optional(),
      }),
    },
    "events.iterate.com/stream/subscription-delivery-resumed": {
      description:
        "The operator's recovery: un-halt the named cursor subscription, optionally seeking its cursor to `afterOffset` first.",
      payloadSchema: z.object({
        name: SubscriptionName,
        afterOffset: z.number().int().nonnegative().optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/stream/created",
    "events.iterate.com/stream/woken",
    "events.iterate.com/stream/paused",
    "events.iterate.com/stream/resumed",
    "events.iterate.com/capability-table/capability-provided",
    "events.iterate.com/capability-table/capability-revoked",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
    "events.iterate.com/stream/subscription-delivery-halted",
    "events.iterate.com/stream/subscription-delivery-resumed",
  ],
  emits: [],
});

export type CoreState = z.infer<typeof CoreContract.stateSchema>;
export type Mount = CoreState["mounts"][number];
export type Subscription = CoreState["subscriptions"][string];

export class CoreStreamProcessor extends StreamProcessor<CoreState> {
  readonly contract = CoreContract;

  // Ephemeral control events are IGNORED (they would vanish from any rebuild); a malformed payload
  // is SKIPPED loudly — one bad hand-appended event must not wedge every later commit.
  override reduce({ event, state }: ReduceArgs<CoreState>): CoreState | undefined {
    if (event.ephemeral) return undefined;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "events.iterate.com/stream/created":
        return {
          ...state,
          projectId: p.projectId as string,
          path: p.path as string,
          createdAt: event.createdAt,
        };
      case "events.iterate.com/stream/woken":
        return { ...state, incarnation: p.incarnation as number };
      case "events.iterate.com/stream/paused":
        return { ...state, paused: { reason: (p.reason as string | undefined) ?? "paused" } };
      case "events.iterate.com/stream/resumed":
        return { ...state, paused: null };

      case "events.iterate.com/capability-table/capability-provided": {
        let mount: Mount;
        try {
          mount = {
            path: parseCapabilityPath(p.path as string),
            target: parse(p.target as string),
            providedAtOffset: event.offset,
          };
        } catch (error) {
          log.warn("skipping malformed capability-provided", { offset: event.offset, error });
          return undefined;
        }
        return { ...state, mounts: [...state.mounts, mount] };
      }
      case "events.iterate.com/capability-table/capability-revoked": {
        // A revoke of an already-gone mount is a NO-OP (undefined), not a fresh object: the inline
        // host detects change by identity, and a benign double-revoke must not rewrite the
        // checkpoint or publish a live-state delta.
        const mounts = state.mounts.filter((m) => m.providedAtOffset !== p.providedAtOffset);
        return mounts.length === state.mounts.length ? undefined : { ...state, mounts };
      }

      case "events.iterate.com/stream/subscription-configured": {
        let target: Expression;
        try {
          target = parse(p.target as string);
        } catch (error) {
          log.warn("skipping malformed subscription-configured", { offset: event.offset, error });
          return undefined;
        }
        const consumes = p.consumes as string[] | undefined;
        return {
          ...state,
          subscriptions: {
            ...state.subscriptions,
            [p.name as string]: {
              target,
              ...(consumes && { consumes }),
              configuredAtOffset: event.offset,
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-removed": {
        if (!((p.name as string) in state.subscriptions)) return undefined;
        const { [p.name as string]: _gone, ...rest } = state.subscriptions;
        return { ...state, subscriptions: rest };
      }
      case "events.iterate.com/stream/subscription-delivery-halted": {
        const row = state.subscriptions[p.name as string];
        if (!row) return undefined;
        return {
          ...state,
          subscriptions: {
            ...state.subscriptions,
            [p.name as string]: {
              ...row,
              halted: {
                afterOffset: p.afterOffset as number,
                attempts: p.attempts as number,
                ...(p.error !== undefined && { error: p.error as string }),
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-delivery-resumed": {
        const row = state.subscriptions[p.name as string];
        if (!row) return undefined;
        const { halted: _cleared, ...kept } = row;
        return {
          ...state,
          subscriptions: {
            ...state.subscriptions,
            [p.name as string]: {
              ...kept,
              resumed: {
                ...(p.afterOffset !== undefined && { afterOffset: p.afterOffset as number }),
                atOffset: event.offset,
              },
            },
          },
        };
      }
      default:
        return undefined;
    }
  }
}
