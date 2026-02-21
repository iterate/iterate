/**
 * Tracing helpers for event provenance.
 *
 * Provides utilities to:
 * - Read TraceContext from the current Effect span
 * - Create ExternalSpan from an Event's trace context
 * - Pipe helper to inherit trace context from an event
 */
import { Effect, Option, Tracer } from "effect";

import type { Event } from "../domain.ts";
import { SpanId, TraceContext, TraceId } from "./trace-context.ts";

// -------------------------------------------------------------------------------------
// Reading trace context
// -------------------------------------------------------------------------------------

/**
 * Read TraceContext from the current Effect span.
 * Returns a synthetic trace context if no span exists.
 * Used by EventStream.append to embed trace info in events.
 */
export const fromCurrentSpan: Effect.Effect<TraceContext> = Effect.currentSpan.pipe(
  Effect.map((span) =>
    TraceContext.make({
      traceId: TraceId.make(span.traceId),
      spanId: SpanId.make(span.spanId),
      parentSpanId: Option.map(span.parent, (p) => SpanId.make(p.spanId)),
    }),
  ),
  Effect.orElseSucceed(() =>
    TraceContext.make({
      traceId: TraceId.make(`untraced-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      spanId: SpanId.make("untraced"),
      parentSpanId: Option.none(),
    }),
  ),
);

// -------------------------------------------------------------------------------------
// Linking to event traces
// -------------------------------------------------------------------------------------

/**
 * Create an ExternalSpan from an Event's trace context.
 * Used to link processor work to the originating event's trace.
 */
export const externalSpanFromEvent = (event: Event): Tracer.ExternalSpan =>
  Tracer.externalSpan({
    traceId: event.trace.traceId,
    spanId: event.trace.spanId,
    sampled: true,
  });

/**
 * Pipe helper: inherit trace context from an event.
 * Usage: someEffect.pipe(withTraceFromEvent(event))
 */
export const withTraceFromEvent =
  (event: Event) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withParentSpan(self, externalSpanFromEvent(event));

/**
 * Pipe helper: create a span AND link it to an event's trace.
 * Combines Effect.withSpan + withTraceFromEvent in one call.
 * Auto-annotates span with event context (path, offset, type).
 * Usage: someEffect.pipe(withSpanFromEvent("my-span", event))
 */
export const withSpanFromEvent =
  (name: string, event: Event) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.tap(() =>
        Effect.all([
          Effect.annotateCurrentSpan("stream.path", event.path),
          Effect.annotateCurrentSpan("event.offset", event.offset),
          Effect.annotateCurrentSpan("event.type", event.type),
        ]),
      ),
      Effect.withSpan(name),
      withTraceFromEvent(event),
    );
