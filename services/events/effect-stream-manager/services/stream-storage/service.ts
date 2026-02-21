/**
 * StreamStorage service definition
 */
import { Context, Effect, Schema, Stream } from "effect";
import type { PushSubscriptionCallbackAddedPayload } from "@iterate-com/services-contracts/events";

import { Event, Offset, StreamPath } from "../../domain.ts";

// -------------------------------------------------------------------------------------
// Type ID (for nominal uniqueness)
// -------------------------------------------------------------------------------------

export const StreamStorageManagerTypeId: unique symbol = Symbol.for("@app/StreamStorageManager");
export type StreamStorageManagerTypeId = typeof StreamStorageManagerTypeId;

// -------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------

export class StreamStorageError extends Schema.TaggedError<StreamStorageError>()(
  "StreamStorageError",
  {
    cause: Schema.Defect,
    context: Schema.optionalWith(Schema.Unknown, { default: () => undefined }),
  },
) {}

export interface PushSubscriptionState {
  readonly subscription: PushSubscriptionCallbackAddedPayload;
  readonly lastDeliveredOffset?: Offset;
}

export interface StreamInfo {
  readonly path: StreamPath;
  readonly createdAt: string;
  readonly eventCount: number;
  readonly lastEventCreatedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// -------------------------------------------------------------------------------------
// StreamStorage (path-scoped data type)
// -------------------------------------------------------------------------------------

/**
 * A path-scoped storage interface - the path is already applied.
 */
export interface StreamStorage {
  /** Read events from this stream */
  readonly read: (options?: { from?: Offset; to?: Offset }) => Stream.Stream<Event>;

  /** Append an event to this stream (already has offset/createdAt assigned) */
  readonly append: (event: Event) => Effect.Effect<Event>;

  /** Read current push subscription metadata for this stream */
  readonly listPushSubscriptions: () => Effect.Effect<ReadonlyArray<PushSubscriptionState>>;

  /** Persist the latest delivered offset for a push subscription */
  readonly setPushSubscriptionOffset: (input: {
    subscriptionSlug: string;
    offset: Offset;
  }) => Effect.Effect<void>;
}

// -------------------------------------------------------------------------------------
// StreamStorageManager (service with path in calls)
// -------------------------------------------------------------------------------------

/**
 * Storage manager service - manages storage across all paths.
 */
export interface StreamStorageManager {
  readonly [StreamStorageManagerTypeId]: StreamStorageManagerTypeId;

  /** List all existing stream paths */
  readonly listPaths: () => Effect.Effect<StreamPath[], StreamStorageError>;

  /** List streams with metadata/stats */
  readonly listStreams: () => Effect.Effect<ReadonlyArray<StreamInfo>, StreamStorageError>;

  /** Ensure the stream metadata row exists even before the first event */
  readonly ensurePath: (input: { path: StreamPath }) => Effect.Effect<void, StreamStorageError>;

  /** Get a path-scoped StreamStorage */
  readonly forPath: (path: StreamPath) => StreamStorage;

  /**
   * Read events from stream.
   * @param from - Exclusive start offset. Returns events with offset > from.
   * @param to - Inclusive end offset. Returns events with offset <= to.
   */
  readonly read: (input: {
    path: StreamPath;
    from?: Offset;
    to?: Offset;
  }) => Stream.Stream<Event, StreamStorageError>;

  /** Append event to stream (path is taken from event.path) */
  readonly append: (event: Event) => Effect.Effect<Event, StreamStorageError>;

  /** Read current push subscription metadata for a stream */
  readonly listPushSubscriptions: (input: {
    path: StreamPath;
  }) => Effect.Effect<ReadonlyArray<PushSubscriptionState>, StreamStorageError>;

  /** Persist the latest delivered offset for a push subscription */
  readonly setPushSubscriptionOffset: (input: {
    path: StreamPath;
    subscriptionSlug: string;
    offset: Offset;
  }) => Effect.Effect<void, StreamStorageError>;
}

export const StreamStorageManager = Context.GenericTag<StreamStorageManager>(
  "@app/StreamStorageManager",
);
