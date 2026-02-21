/**
 * TraceContext schema and branded types for event provenance tracking.
 *
 * Uses Effect's native tracing infrastructure - traceId and spanId
 * are stored with events to allow reconstructing the trace hierarchy.
 */
import { Schema } from "effect";

// -------------------------------------------------------------------------------------
// Branded types
// -------------------------------------------------------------------------------------

export const TraceId = Schema.String.pipe(Schema.brand("TraceId"));
export type TraceId = typeof TraceId.Type;

export const SpanId = Schema.String.pipe(Schema.brand("SpanId"));
export type SpanId = typeof SpanId.Type;

// -------------------------------------------------------------------------------------
// TraceContext
// -------------------------------------------------------------------------------------

/**
 * Embedded trace context stored with each event.
 *
 * Allows reconstructing the span hierarchy:
 * - traceId: groups all related events in the same trace
 * - spanId: identifies the specific span that created this event
 * - parentSpanId: links to the parent span (if any)
 */
export class TraceContext extends Schema.Class<TraceContext>("TraceContext")({
  traceId: TraceId,
  spanId: SpanId,
  parentSpanId: Schema.OptionFromNullOr(SpanId),
}) {}
