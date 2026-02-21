/**
 * Shared domain types for durable streams
 */
import { Schema } from "effect";

import { TraceContext } from "./tracing/trace-context.ts";

// -------------------------------------------------------------------------------------
// Branded primitives
// -------------------------------------------------------------------------------------

export const StreamPath = Schema.String.pipe(Schema.brand("StreamPath"));
export type StreamPath = typeof StreamPath.Type;

const Offset_ = Schema.String.pipe(Schema.brand("Offset"));
type Offset_ = typeof Offset_.Type;

/** Offset comparison utilities (zero-padded strings compare correctly) */
const OffsetExtensions = {
  /** a > b (strictly greater) */
  gt: (a: Offset_, b: Offset_): boolean => a > b,
  /** a >= b */
  gte: (a: Offset_, b: Offset_): boolean => a >= b,
  /** a < b */
  lt: (a: Offset_, b: Offset_): boolean => a < b,
  /** a <= b */
  lte: (a: Offset_, b: Offset_): boolean => a <= b,
};

export const Offset = Object.assign(Offset_, OffsetExtensions);
export type Offset = Offset_;

export const EventType = Schema.String.pipe(Schema.brand("EventType"));
export type EventType = typeof EventType.Type;

// Accept string or number, coerce to string
const VersionFromInput = Schema.Union(
  Schema.String,
  Schema.transform(Schema.Number, Schema.String, {
    decode: (n) => String(n),
    encode: (s) => Number(s),
  }),
);
export const Version = VersionFromInput.pipe(Schema.brand("Version"));
export type Version = typeof Version.Type;

export const Payload = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type Payload = typeof Payload.Type;

// -------------------------------------------------------------------------------------
// EventInput (base) -> Event (extended with offset + createdAt)
// -------------------------------------------------------------------------------------

/** Event input - what callers provide to append */
export class EventInput extends Schema.Class<EventInput>("EventInput")({
  type: EventType,
  payload: Payload,
  version: Schema.optionalWith(Version, { default: () => Version.make("1") }),
}) {}

/** Full event with path, offset and createdAt assigned by storage */
export class Event extends EventInput.extend<Event>("Event")({
  path: StreamPath,
  offset: Offset,
  createdAt: Schema.DateTimeUtc,
  trace: TraceContext,
}) {}
