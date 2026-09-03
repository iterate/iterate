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

import {
  parse,
  parseItxExpressionPrefix,
  type ItxExpression,
  type ItxExpressionPrefix,
} from "../context/expression.ts";
import type { StreamEventInput } from "./events.ts";
import { StreamProcessor, type ProcessorContract, type ReduceArgs } from "./processor.ts";

/** One rewrite rule: a canonical match prefix and the target it rewrites to (both parsed once, at
 *  reduce; a call step pins literal args, `itx.ai.run('gpt-5')` — expression.ts). */
export type ItxExpressionRewriteRule = { match: ItxExpressionPrefix; target: ItxExpression };

/** One subscription row (by name; a same-named configure REPLACES). */
export type Subscription = {
  /** The target, parsed; its terminal is callable with (events, range). */
  target: ItxExpression;
  /** Event types delivered; absent = every durable event; naming a type opts its ephemerals in. */
  consumes?: string[];
  /** The row's identity — the offset of its subscription-configured event. */
  configuredAtOffset: number;
  /** A CURSOR target that exhausted its retries (the loop appended the halted fact). */
  halted?: { afterOffset: number; attempts: number; error?: string };
  /** The newest delivery-resumed: the loop applies it once (a seek, an un-halt). */
  resumed?: { afterOffset?: number; atOffset: number };
};

/** THE CORE STATE — the context's own state, reduced inline at the commit point. HAND-WRITTEN (no
 *  zod on the edge/DO script): these events are the platform's own, trusted, and the reduce reads
 *  them by hand, so the 310 KB zod runtime validator earned its removal. `paused` and the two tables
 *  are always present (the initial state defaults them); the identity fields fill in from
 *  created/woken. */
export type CoreState = {
  /** From the birth certificate (stream/created, offset 1). */
  projectId?: string;
  path?: string;
  createdAt?: string;
  /** From the wake record (stream/woken) — growth across idle is the hibernation tell. */
  incarnation?: number;
  paused: { reason: string } | null;
  /** THE REWRITE-RULE TABLE, by canonical match: a configured target REPLACES, `null` DELETES (a
   *  map — no stack, no identity beyond the match). */
  itxExpressionRewriteRules: Record<string, ItxExpressionRewriteRule>;
  /** THE SUBSCRIPTIONS TABLE, by name. */
  subscriptions: Record<string, Subscription>;
};

/** A subscription/registry name is ONE segment, [A-Za-z0-9_-]: the facet name for a processor, the
 *  registry key's tail for a live callback. (Was a zod `.regex` on the SDK; hand-checked here now.) */
const SUBSCRIPTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export function parseSubscriptionName(name: string): string {
  if (typeof name !== "string" || !SUBSCRIPTION_NAME_PATTERN.test(name))
    throw new Error(
      `a subscription name is one segment: [A-Za-z0-9_-]+ (got ${JSON.stringify(name)})`,
    );
  return name;
}

/** The event types the core reduce consumes — and the only types its `buildEvent` will build. */
const CORE_EVENT_TYPES = [
  "events.iterate.com/stream/created",
  "events.iterate.com/stream/woken",
  "events.iterate.com/stream/paused",
  "events.iterate.com/stream/resumed",
  "events.iterate.com/itx/rewrite-rule-configured",
  "events.iterate.com/stream/subscription-configured",
  "events.iterate.com/stream/subscription-delivery-halted",
  "events.iterate.com/stream/subscription-delivery-resumed",
] as const;
const CORE_EVENT_TYPE_SET = new Set<string>(CORE_EVENT_TYPES);

/** THE CORE CONTRACT — hand-built (was `defineProcessorContract` + a zod schema). `buildEvent` for a
 *  trusted core command checks the type is owned and passes the payload through: the command builders
 *  (itx-expression-rewriting.ts `rewriteRuleConfiguredEvent`, subscriptions.ts
 *  `subscriptionConfiguredEvent`) construct the exact payload and validate rooting themselves.
 *  `initialState` is the literal every-field-defaulted state. */
export const CoreContract: ProcessorContract<CoreState> & {
  buildEvent: (event: {
    type: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  }) => StreamEventInput;
} = {
  slug: "core",
  version: "4.0.0", // 4.0.0: rewrite rules are a MAP under itx/rewrite-rule-configured; subscription-configured absorbs removal
  description:
    "The context's own state, reduced inline at the commit point: who it is, which incarnation runs, whether appends are paused, the itx-expression rewrite rules every call goes through, and the subscriptions every commit is sent to.",
  consumes: CORE_EVENT_TYPES,
  emits: [],
  initialState: (): CoreState => ({
    paused: null,
    itxExpressionRewriteRules: {},
    subscriptions: {},
  }),
  buildEvent: (event) => {
    if (!CORE_EVENT_TYPE_SET.has(event.type))
      throw new Error(`contract "core": buildEvent event type "${event.type}" is not owned`);
    return {
      type: event.type,
      payload: event.payload ?? {},
      ...(event.idempotencyKey && { idempotencyKey: event.idempotencyKey }),
    };
  },
};

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
