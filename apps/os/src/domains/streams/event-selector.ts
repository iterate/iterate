// EventSelector: THE one way to say "which subset of a stream's events".
//
// Every lane speaks it — ephemeral `subscribe()` calls, durable wake-mode
// subscriptions (derived from the processor contract's `consumes`), and push
// subscriptions (persisted in `subscription-configured`). One zod schema, one
// compiled matcher, one JSONata cache; no lane grows its own filter dialect.
//
// Selectors FILTER, they never construct: a selector may reject an event, but
// output shaping belongs to receivers (see the streams README doctrine). The
// filter is skip-not-defer everywhere — a cursor advances past non-matching
// events; they are skipped, not deferred.

import jsonata from "@mmkal/jsonata/sync";
import { z } from "zod";
import type { StreamEvent } from "./schemas.ts";

/**
 * A declarative event filter. Both fields optional; an absent selector (or an
 * empty object) matches everything.
 */
export const EventSelector = z.object({
  /**
   * Exact event types to match. `"*"` anywhere in the list means "all types"
   * (the processor-contract `consumes` convention). An empty list is rejected:
   * a subscription that can never match anything is a configure-time mistake,
   * not a valid desired state.
   */
  eventTypes: z.array(z.string().trim().min(1)).min(1).optional(),
  /**
   * Optional JSONata expression evaluated against the committed event
   * (`{ type, payload, metadata, source, offset, createdAt, path }`). The
   * event matches only when the expression evaluates to exactly `true` — e.g.
   * `payload.body.repository.full_name = "acme/widgets"` narrows a GitHub
   * connection stream's webhook firehose to one repository. Parse errors are
   * rejected at configure time (`compileEventSelector` throws); an expression
   * that throws at match time is the CALLER's decision to record and skip.
   */
  condition: z.string().trim().min(1).optional(),
});

export type EventSelector = z.infer<typeof EventSelector>;

/** A selector compiled to a predicate. `matches` throws only on condition evaluation errors. */
export type CompiledEventSelector = {
  matches(event: StreamEvent): boolean;
};

// Compiled-expression cache: selector conditions (and cross-post transforms,
// which share this compiler) re-evaluate on every matching append, and a
// stream's expression set is small and stable, so compile-once is the
// sensible steady state. Bounded so pathological churn of expressions cannot
// grow the map without limit (clearing wholesale is fine — recompiling is
// cheap, correctness never depends on the cache).
const compiledExpressions = new Map<string, jsonata.Expression>();
const MAX_COMPILED_EXPRESSIONS = 200;

/**
 * Parse a JSONata expression, throwing on invalid input. Used for selector
 * `condition`s (must evaluate to exactly `true` to match) and for
 * `Stream.acceptCrossPost` transforms (construct the cross-posted event body) — one
 * compiler, one cache, one language for everything expression-shaped that
 * evaluates against a committed event.
 */
export function compileJsonataExpression(expression: string): jsonata.Expression {
  const cached = compiledExpressions.get(expression);
  if (cached !== undefined) return cached;
  const compiled = jsonata(expression);
  if (compiledExpressions.size >= MAX_COMPILED_EXPRESSIONS) compiledExpressions.clear();
  compiledExpressions.set(expression, compiled);
  return compiled;
}

/**
 * Compiles a selector to a predicate. Throws on an unparseable `condition`,
 * which makes this double as the configure-time validation gate: an
 * unparseable expression must be rejected before it becomes durable desired
 * state, not discovered as a per-event error forever after.
 */
export function compileEventSelector(selector: EventSelector | undefined): CompiledEventSelector {
  const eventTypes =
    selector?.eventTypes === undefined || selector.eventTypes.includes("*")
      ? undefined
      : new Set(selector.eventTypes);
  const condition =
    selector?.condition === undefined ? undefined : compileJsonataExpression(selector.condition);

  return {
    matches(event) {
      if (eventTypes !== undefined && !eventTypes.has(event.type)) return false;
      if (condition !== undefined && condition.evaluate(event) !== true) return false;
      return true;
    },
  };
}
