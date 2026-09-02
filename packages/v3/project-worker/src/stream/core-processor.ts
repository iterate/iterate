// core-processor.ts — THE CORE REDUCE: the one processor the context DO reduces INLINE at its commit
// point. Its reduced state is everything the DO needs SYNCHRONOUSLY at its doors, event-sourced from
// the context's own control events and nothing else:
//
//   who this context is       stream/created { projectId, path }            → projectId · path · createdAt
//   which incarnation runs    stream/woken { incarnation }                  → incarnation
//   may appends land          stream/paused { reason } · stream/resumed     → paused        (one `if` in Stream.append)
//   how calls rewrite         itx/rewrite-rule-configured { match, target|null } → itxExpressionRewriteRules (every invoke)
//   who is sent each commit   stream/subscription-configured { name, target|null }|
//                             -delivery-halted|-delivery-resumed            → subscriptions (the delivery loop)
//
// ONE reduce, no effects, no verbs — the same `StreamProcessor` class every facet processor is,
// owned by the Stream itself (stream.ts `#coreReducedState`, reduced inside every commit) because
// its readers are the append door, the dispatcher and the delivery loop, all synchronous. The COMMANDS that append these events live
// beside the code that reads each slice (context/itx-expression-rewriting.ts for the rules,
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
import {
  parse,
  parseItxExpressionPrefix,
  type ItxExpression,
  type ItxExpressionPrefix,
} from "../context/expression.ts";
import { defineProcessorContract } from "./events.ts";
import { StreamProcessor, type ReduceArgs } from "./processor.ts";

/** One segment, [A-Za-z0-9_-]: the facet name for a processor, the registry key's tail for a live
 *  callback. */
export const SubscriptionName = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "a subscription name is one segment: [A-Za-z0-9_-]+");

export const CoreContract = defineProcessorContract({
  slug: "core",
  version: "4.0.0", // 4.0.0: rewrite rules are a MAP under itx/rewrite-rule-configured; subscription-configured absorbs removal
  description:
    "The context's own state, reduced inline at the commit point: who it is, which incarnation runs, whether appends are paused, the itx-expression rewrite rules every call goes through, and the subscriptions every commit is sent to.",
  stateSchema: z.object({
    /** From the birth certificate (stream/created, offset 1). */
    projectId: z.string().optional(),
    path: z.string().optional(),
    createdAt: z.string().optional(),
    /** From the wake record (stream/woken) — growth across idle is the hibernation tell. */
    incarnation: z.number().optional(),
    paused: z.object({ reason: z.string() }).nullable().default(null),
    /** THE REWRITE-RULE TABLE, by canonical match: a configured target REPLACES, `null` DELETES (a
     *  map — no stack, no identity beyond the match). The EVENT stores both halves as strings; they
     *  are parsed here, once. */
    itxExpressionRewriteRules: z
      .record(
        z.string(),
        z.object({
          /** Dotted names; a call step pins literal args (`itx.ai.run('gpt-5')`) — expression.ts ItxExpressionPrefix. */
          match: z.custom<ItxExpressionPrefix>(() => true),
          target: z.custom<ItxExpression>(() => true),
        }),
      )
      .default({}),
    /** THE SUBSCRIPTIONS TABLE: by name; a same-named configure REPLACES (no stack). */
    subscriptions: z
      .record(
        z.string(),
        z.object({
          /** The target, parsed; its terminal is callable with (events, range). */
          target: z.custom<ItxExpression>(() => true),
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
    "events.iterate.com/itx/rewrite-rule-configured": {
      description:
        "The rewrite rule at `match` is now `target` (string half of the codec — the log stays human-readable) — or, with `target: null`, gone. A call starting with `match` runs as the same call with `match` replaced by `target`. A lent stub's rule targets `itx.rpcStubs.get('<rpcStubKey>')`.",
      payloadSchema: z.object({ match: z.string(), target: z.string().nullable() }),
    },
    "events.iterate.com/stream/subscription-configured": {
      description:
        "Send each committed batch (filtered by `consumes`) to `target`, an itx expression whose terminal is callable with (events, range). Same name REPLACES; `target: null` removes the row (and, for a cursor target, its cursor).",
      payloadSchema: z.object({
        name: SubscriptionName,
        target: z.string().nullable(),
        consumes: z.array(z.string()).optional(),
      }),
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
    "events.iterate.com/itx/rewrite-rule-configured",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-delivery-halted",
    "events.iterate.com/stream/subscription-delivery-resumed",
  ],
  emits: [],
});

export type CoreState = z.infer<typeof CoreContract.stateSchema>;
export type ItxExpressionRewriteRule = CoreState["itxExpressionRewriteRules"][string];
export type Subscription = CoreState["subscriptions"][string];

export class CoreStreamProcessor extends StreamProcessor<CoreState> {
  readonly contract = CoreContract;

  // Ephemeral control events are IGNORED (they would vanish from any rebuild). A malformed payload
  // (a match with an argless call step, a target that does not parse) THROWS here like any reduce would; the
  // host contains it (Stream.#reduceEventIntoCoreReducedState reports the issue and keeps the
  // state), so one bad hand-appended event never wedges a later commit.
  override reduce({ event, state }: ReduceArgs<CoreState>): CoreState | undefined {
    if (event.ephemeral) return undefined;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "events.iterate.com/stream/created":
        return {
          ...state,
          projectId: payload.projectId as string,
          path: payload.path as string,
          createdAt: event.createdAt,
        };
      case "events.iterate.com/stream/woken":
        return { ...state, incarnation: payload.incarnation as number };
      case "events.iterate.com/stream/paused":
        return { ...state, paused: { reason: (payload.reason as string | undefined) ?? "paused" } };
      case "events.iterate.com/stream/resumed":
        return { ...state, paused: null };

      case "events.iterate.com/itx/rewrite-rule-configured": {
        // A `null` on a match that has no rule is a NO-OP (undefined), not a fresh object: the inline
        // host detects change by identity, and a benign double-delete must not rewrite the checkpoint
        // or publish a live-state delta.
        const matchString = payload.match as string;
        if (payload.target === null) {
          if (!(matchString in state.itxExpressionRewriteRules)) return undefined;
          const { [matchString]: _gone, ...rest } = state.itxExpressionRewriteRules;
          return { ...state, itxExpressionRewriteRules: rest };
        }
        return {
          ...state,
          itxExpressionRewriteRules: {
            ...state.itxExpressionRewriteRules,
            [matchString]: {
              match: parseItxExpressionPrefix(matchString),
              target: parse(payload.target as string),
            },
          },
        };
      }

      case "events.iterate.com/stream/subscription-configured": {
        const name = payload.name as string;
        if (payload.target === null) {
          if (!(name in state.subscriptions)) return undefined;
          const { [name]: _gone, ...rest } = state.subscriptions;
          return { ...state, subscriptions: rest };
        }
        const consumes = payload.consumes as string[] | undefined;
        return {
          ...state,
          subscriptions: {
            ...state.subscriptions,
            [name]: {
              target: parse(payload.target as string),
              ...(consumes && { consumes }),
              configuredAtOffset: event.offset,
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-delivery-halted": {
        const row = state.subscriptions[payload.name as string];
        if (!row) return undefined;
        return {
          ...state,
          subscriptions: {
            ...state.subscriptions,
            [payload.name as string]: {
              ...row,
              halted: {
                afterOffset: payload.afterOffset as number,
                attempts: payload.attempts as number,
                ...(payload.error !== undefined && { error: payload.error as string }),
              },
            },
          },
        };
      }
      case "events.iterate.com/stream/subscription-delivery-resumed": {
        const row = state.subscriptions[payload.name as string];
        if (!row) return undefined;
        const { halted: _cleared, ...kept } = row;
        return {
          ...state,
          subscriptions: {
            ...state.subscriptions,
            [payload.name as string]: {
              ...kept,
              resumed: {
                ...(payload.afterOffset !== undefined && {
                  afterOffset: payload.afterOffset as number,
                }),
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
