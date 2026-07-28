// EventFilter: THE one way to say "which subset of a stream's events".
//
// Every event receiver uses it — session callback connections, hosted processors
// (derived from the processor contract's `consumes`), plus copy, ITX-call,
// and webhook subscriptions (persisted in the configuration event). One zod schema,
// one compiled matcher and one JSONata cache.
//
// Filters never construct: a filter may reject an event, but
// output shaping belongs to receivers (see the streams README doctrine). The
// filter is skip-not-defer everywhere — a cursor advances past non-matching
// events; they are skipped, not deferred.

import jsonata from "@mmkal/jsonata/sync";
import { z } from "zod";
import type { StreamEvent } from "iterate/processors";
import { errorMessage } from "./stream-delivery-utils.ts";

/**
 * A declarative event filter. Both fields optional; an absent filter (or an
 * empty object) matches everything.
 */
export const EventFilter = z.strictObject({
  /**
   * Exact event types to match. `"*"` anywhere in the list means "all types"
   * (the processor-contract `consumes` convention). An empty list is rejected:
   * a subscription that can never match anything is a configure-time mistake,
   * not a valid desired state.
   */
  eventTypes: z.array(z.string().trim().min(1)).min(1).optional(),
  /**
   * Optional JSONata condition evaluated against the committed event
   * (`{ type, payload, metadata, source, offset, createdAt, path }`). The
   * event matches only when the expression evaluates to exactly `true` — e.g.
   * `payload.body.repository.full_name = "acme/widgets"` narrows a GitHub
   * connection stream's webhook firehose to one repository. Parse errors are
   * rejected at configure time (`compileEventFilter` throws); an expression
   * that throws at match time is the CALLER's decision to record and skip.
   */
  jsonataCondition: z.string().trim().min(1).optional(),
});

/** A declarative event filter; an absent filter or empty object matches every event. */
export type EventFilter = z.infer<typeof EventFilter>;

/** A filter compiled to a predicate. `matches` throws only on condition evaluation errors. */
export type CompiledEventFilter = {
  matches(event: StreamEvent): boolean;
};

/** A valid filter expression failed only for the event it was evaluating. */
export class EventFilterEvaluationError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error), { cause: error });
    this.name = "EventFilterEvaluationError";
  }
}

// Compiled-expression cache: filter conditions
// re-evaluate on every matching append, and a
// stream's expression set is small and stable, so compile-once is the
// sensible steady state. Bounded so pathological churn of expressions cannot
// grow the map without limit (clearing wholesale is fine — recompiling is
// cheap, correctness never depends on the cache).
const compiledExpressions = new Map<string, jsonata.Expression>();
const MAX_COMPILED_EXPRESSIONS = 200;

/**
 * Parse a JSONata expression, throwing on invalid input. Used for filter
 * `jsonataCondition`s (must evaluate to exactly `true` to match) — one
 * compiler, one cache, one language for everything expression-shaped that
 * evaluates against a committed event.
 */
export function compileJsonataExpression(expression: string): jsonata.Expression {
  const cached = compiledExpressions.get(expression);
  if (cached !== undefined) return cached;
  let compiled: jsonata.Expression;
  try {
    compiled = jsonata(expression);
  } catch (error) {
    // JSONata's parser throws a plain object. Across Workers RPC that degrades
    // to the useless message "[object Object]" unless this boundary turns it
    // into a real Error before it escapes.
    const parserError = error as {
      code?: unknown;
      message?: unknown;
      position?: unknown;
    };
    const code = typeof parserError?.code === "string" ? parserError.code : undefined;
    const position =
      typeof parserError?.position === "number" && Number.isFinite(parserError.position)
        ? parserError.position
        : undefined;
    const message =
      typeof parserError?.message === "string" && parserError.message.length > 0
        ? parserError.message
        : String(error);
    const coordinates = [code, position === undefined ? undefined : `position ${position}`]
      .filter((value) => value !== undefined)
      .join(", ");
    throw new Error(
      `invalid JSONata expression${coordinates.length === 0 ? "" : ` (${coordinates})`}: ${message}`,
      { cause: error },
    );
  }
  if (compiledExpressions.size >= MAX_COMPILED_EXPRESSIONS) compiledExpressions.clear();
  compiledExpressions.set(expression, compiled);
  return compiled;
}

/**
 * Compiles a filter to a predicate. Throws on an unparseable `jsonataCondition`,
 * which makes this double as the configure-time validation gate: an
 * unparseable expression must be rejected before it becomes durable desired
 * state, not discovered as a per-event error forever after.
 */
export function compileEventFilter(filter: EventFilter | undefined): CompiledEventFilter {
  const eventTypes =
    filter?.eventTypes === undefined || filter.eventTypes.includes("*")
      ? undefined
      : new Set(filter.eventTypes);
  const condition =
    filter?.jsonataCondition === undefined
      ? undefined
      : compileJsonataExpression(filter.jsonataCondition);

  return {
    matches(event) {
      if (eventTypes !== undefined && !eventTypes.has(event.type)) return false;
      if (condition !== undefined) {
        let result: unknown;
        try {
          result = condition.evaluate(event);
        } catch (error) {
          throw new EventFilterEvaluationError(error);
        }
        if (result !== true) return false;
      }
      return true;
    },
  };
}
