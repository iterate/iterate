/**
 * Core types for event streams
 */
import { Schema } from "effect";

// Branded types
export const StreamName = Schema.String.pipe(Schema.nonEmptyString(), Schema.brand("StreamName"));
export type StreamName = typeof StreamName.Type;

export const EventStreamId = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.brand("EventStreamId"),
);
export type EventStreamId = typeof EventStreamId.Type;

export const Offset = Schema.String.pipe(Schema.brand("Offset"));
export type Offset = typeof Offset.Type;

/** Zero-padded 16-char offset for lexicographic sorting */
export const makeOffset = (n: number): Offset => String(n).padStart(16, "0") as Offset;

export const parseOffset = (offset: Offset): number => parseInt(offset, 10);

/** Special offset meaning "start from beginning" per event-stream spec */
export const OFFSET_START = "-1" as Offset;

export const isStartOffset = (offset: Offset): boolean => offset === OFFSET_START;

// Event schema
export class Event extends Schema.Class<Event>("Event")({
  offset: Offset,
  eventStreamId: EventStreamId,
  data: Schema.Unknown,
  createdAt: Schema.String,
}) {}

// Errors
export class StreamNotFoundError extends Schema.TaggedError<StreamNotFoundError>()(
  "StreamNotFoundError",
  { name: StreamName },
) {}

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class InvalidOffsetError extends Schema.TaggedError<InvalidOffsetError>()(
  "InvalidOffsetError",
  {
    offset: Schema.String,
    message: Schema.String,
  },
) {}
