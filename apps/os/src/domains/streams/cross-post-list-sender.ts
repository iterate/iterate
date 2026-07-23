// Sends a source stream's complete current cross-post list to each receiving
// stream. Commands and receiver-side recording stay in StreamDurableObject;
// this class owns only the durable source-side call/retry/wait state machine.

import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { jsonValuesEqual } from "iterate/processors";
import { StreamEvent as StreamEventSchema } from "iterate/processors";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import {
  parseCommittedCoreEvent,
  recordedSubscriptionForCrossPost,
  type CommittedCrossPostListRecordedEvent,
  type CoreProcessorState,
  type CrossPostListRecordedPayload,
} from "./core-processor-contract.ts";
import { compareSourceListPosition } from "./core-processor.ts";
import { computeBackoffMs } from "./delivery-math.ts";
import {
  MAX_CROSS_POST_LIST_ATTEMPTS,
  type CrossPostListRetryRow,
  type CrossPostListRetryStore,
} from "./cross-post-list-retry-store.ts";
import {
  boundedErrorMessage,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  errorMessage,
  internalStreamId,
  withDeliveryTimeout,
} from "./stream-delivery-utils.ts";
import { isDurableObjectLifecycleError } from "./stream-unavailable.ts";

const MAX_CONCURRENT_RECEIVER_CALLS = 4;
const RECEIVER_CALL_WATCHDOG_GRACE_MS = 1_000;

class SourceLifetimeConflictError extends Error {}

export type CrossPostListRetryStateStore = Pick<
  CrossPostListRetryStore,
  "delete" | "ensure" | "fail" | "get" | "list" | "prune"
>;

export type BlockedCrossPostListResult = {
  status: "blocked";
  receivingStreamPath: string;
  attempts: number;
  message: string;
};

type CrossPostListBlockedError = Error & {
  crossPostListBlocked: true;
  receivingStreamPath: string;
  attempts: number;
  lastError: string;
};

export function crossPostListBlockedError(args: {
  receivingStreamPath: string;
  attempts: number;
  lastError: string;
}): CrossPostListBlockedError {
  const message = `sending this source's cross-post list to "${args.receivingStreamPath}" is blocked after ${args.attempts} attempts: ${args.lastError}. Fix the reported failure, then call resendCrossPostList({ receivingStreamPath: "${args.receivingStreamPath}" }) to try again`;
  return Object.assign(new Error(message), {
    crossPostListBlocked: true as const,
    receivingStreamPath: args.receivingStreamPath,
    attempts: args.attempts,
    lastError: args.lastError,
  });
}

export function isCrossPostListBlockedError(error: unknown): error is CrossPostListBlockedError {
  return (
    error instanceof Error &&
    (error as Error & { crossPostListBlocked?: unknown }).crossPostListBlocked === true
  );
}

export function blockedCrossPostListResult(
  error: CrossPostListBlockedError,
): BlockedCrossPostListResult {
  return {
    status: "blocked",
    receivingStreamPath: error.receivingStreamPath,
    attempts: error.attempts,
    message: error.message,
  };
}

export function isCrossPostListBackoffError(
  error: unknown,
): error is Error & { crossPostListBackoff: true } {
  return (
    error instanceof Error &&
    (error as Error & { crossPostListBackoff?: unknown }).crossPostListBackoff === true
  );
}

type CrossPostListSenderHooks = {
  readonly projectId: string | null;
  readonly path: string;
  coreState(): CoreProcessorState;
  readonly retryStore: CrossPostListRetryStateStore;
  appendCore(event: StreamEventInput): StreamEvent;
  getEvent(args: { offset: number } | { idempotencyKey: string }): StreamEvent | undefined;
  latestCrossPostListRecordedByReceiver(receivingStreamPath: string): StreamEvent | undefined;
  recordCrossPostListOnReceivingStream(path: string, event: StreamEventInput): Promise<unknown>;
  scheduleDurable(work: () => Promise<unknown>): void;
  armAlarm(atMs: number): void;
  now(): number;
  random(): number;
};

/**
 * Synchronizes one source stream's current cross-post subscriptions with the
 * streams that receive from it. Selected-event delivery is deliberately not
 * here; StreamEventSender starts only after this protocol confirms the receipt.
 */
export class CrossPostListSender {
  readonly #hooks: CrossPostListSenderHooks;
  readonly #callsInFlight = new Map<
    string,
    { sourceOffset: number; promise: Promise<StreamEvent | null> }
  >();

  constructor(hooks: CrossPostListSenderHooks) {
    this.#hooks = hooks;
  }

  runtimeState(): Record<string, CrossPostListRetryRow> {
    return Object.fromEntries(
      this.#hooks.retryStore.list().map((retry) => [retry.receivingStreamPath, retry]),
    );
  }

  /** Re-derive every owed cross-post-list call from reduced state after a commit or alarm. */
  reconcile(): void {
    const receivingStreamPaths = new Set<string>();
    for (const [receivingStreamPath, list] of Object.entries(
      this.#hooks.coreState().crossPostListDeliveriesByReceivingStream,
    )) {
      if (list.status === "confirmed") continue;
      receivingStreamPaths.add(receivingStreamPath);
      if (list.status === "blocked") {
        // The appended blocked event is the sole durable authority for the
        // terminal attempt/error/timestamp. This table exists only while a
        // future retry is schedulable, so retaining a blocked row would make
        // the same facts independently writable in two places.
        this.#hooks.retryStore.delete(receivingStreamPath, list.sourceOffset);
        continue;
      }
      this.#hooks.retryStore.ensure(receivingStreamPath, list.sourceOffset);
      this.#schedule(receivingStreamPath, list.sourceOffset);
    }
    this.#hooks.retryStore.prune(receivingStreamPaths);
  }

  /**
   * Outside an alarm turn this persists an immediate alarm. Inside one, the
   * single loop below decides whether to join, wait for capacity, send, or
   * respect backoff. Keeping eligibility there avoids drift between callers.
   */
  #schedule(receivingStreamPath: string, sourceOffset: number): void {
    const tracker =
      this.#hooks.coreState().crossPostListDeliveriesByReceivingStream[receivingStreamPath];
    if (tracker?.sourceOffset !== sourceOffset || tracker.status !== "pending") return;
    const row = this.#hooks.retryStore.ensure(receivingStreamPath, sourceOffset);
    if (row.nextAttemptAt !== null && row.nextAttemptAt > this.#hooks.now()) {
      this.#hooks.armAlarm(row.nextAttemptAt);
      return;
    }
    this.#hooks.scheduleDurable(async () => {
      await this.#startOrJoin({ receivingStreamPath, sourceOffset });
    });
  }

  /** The only loop that starts or joins a source-to-receiver list call. */
  async #startOrJoin(args: {
    receivingStreamPath: string;
    sourceOffset: number;
  }): Promise<StreamEvent | null> {
    for (;;) {
      const tracker =
        this.#hooks.coreState().crossPostListDeliveriesByReceivingStream[args.receivingStreamPath];
      if (tracker === undefined || tracker.sourceOffset !== args.sourceOffset) return null;
      if (tracker.status === "confirmed") return null;
      if (tracker.status === "blocked") {
        throw crossPostListBlockedError({
          receivingStreamPath: args.receivingStreamPath,
          attempts: tracker.attempts,
          lastError: tracker.error,
        });
      }

      const retry = this.#hooks.retryStore.get(args.receivingStreamPath);
      if (
        retry?.sourceOffset === args.sourceOffset &&
        retry.nextAttemptAt !== null &&
        retry.nextAttemptAt > this.#hooks.now()
      ) {
        throw Object.assign(
          new Error(
            `sending this source's cross-post list to "${args.receivingStreamPath}" is backing off after attempt ${retry.attempt} until ${new Date(retry.nextAttemptAt).toISOString()}`,
          ),
          { crossPostListBackoff: true as const },
        );
      }

      const existing = this.#callsInFlight.get(args.receivingStreamPath);
      if (existing !== undefined) {
        if (existing.sourceOffset === args.sourceOffset) return existing.promise;
        try {
          await existing.promise;
        } catch {
          // The one call that started the promise owns its failure accounting.
        }
        continue;
      }

      if (this.#callsInFlight.size >= MAX_CONCURRENT_RECEIVER_CALLS) {
        await Promise.race(
          [...this.#callsInFlight.values()].map(({ promise }) =>
            promise.then(
              () => undefined,
              () => undefined,
            ),
          ),
        );
        continue;
      }

      const row = this.#hooks.retryStore.ensure(args.receivingStreamPath, args.sourceOffset);
      if (row.sourceOffset !== args.sourceOffset) return null;

      const promise = this.#runAttempt(args);
      this.#callsInFlight.set(args.receivingStreamPath, {
        sourceOffset: args.sourceOffset,
        promise,
      });
      try {
        return await promise;
      } finally {
        const current = this.#callsInFlight.get(args.receivingStreamPath);
        if (current?.promise === promise) {
          this.#callsInFlight.delete(args.receivingStreamPath);
          queueMicrotask(() => this.reconcile());
        }
      }
    }
  }

  async #runAttempt(args: {
    receivingStreamPath: string;
    sourceOffset: number;
  }): Promise<StreamEvent | null> {
    this.#hooks.armAlarm(
      this.#hooks.now() + DEFAULT_DELIVERY_TIMEOUT_MS + RECEIVER_CALL_WATCHDOG_GRACE_MS,
    );
    try {
      return await this.#sendCurrentList(args);
    } catch (error) {
      const current = this.#hooks.retryStore.get(args.receivingStreamPath);
      if (current !== undefined && current.sourceOffset === args.sourceOffset) {
        const attempt = current.attempt + 1;
        const message = errorMessage(error);
        if (error instanceof SourceLifetimeConflictError) {
          this.#block(args.receivingStreamPath, {
            sourceOffset: args.sourceOffset,
            attempt,
            error: boundedErrorMessage(message) ?? "source lifetime conflict",
          });
        } else if (attempt >= MAX_CROSS_POST_LIST_ATTEMPTS) {
          this.#block(args.receivingStreamPath, {
            sourceOffset: args.sourceOffset,
            attempt,
            error: boundedErrorMessage(message) ?? "unknown error",
          });
        } else {
          const nextAttemptAt = this.#hooks.now() + computeBackoffMs(attempt, this.#hooks.random());
          this.#hooks.retryStore.fail(args.receivingStreamPath, {
            sourceOffset: args.sourceOffset,
            attempt,
            nextAttemptAt,
            error: message,
          });
          this.#hooks.armAlarm(nextAttemptAt);
          console.warn("sending cross-post list to receiving stream failed; retry scheduled", {
            receivingStreamPath: args.receivingStreamPath,
            sourceOffset: args.sourceOffset,
            attempt,
            nextAttemptAt,
            error: message,
          });
        }
      }
      throw error;
    }
  }

  #block(
    receivingStreamPath: string,
    args: { sourceOffset: number; attempt: number; error: string },
  ): void {
    try {
      const tracker =
        this.#hooks.coreState().crossPostListDeliveriesByReceivingStream[receivingStreamPath];
      if (tracker?.sourceOffset !== args.sourceOffset || tracker.status !== "pending") return;
      this.#hooks.appendCore({
        type: "events.iterate.com/stream/cross-post-list-delivery-blocked",
        idempotencyKey: internalStreamId(
          "cross-post-list-delivery-blocked",
          receivingStreamPath,
          args.sourceOffset,
        ),
        payload: {
          receivingStreamPath,
          sourceOffset: args.sourceOffset,
          attempts: args.attempt,
          error: boundedErrorMessage(args.error) ?? "unknown error",
        },
      });
      const blocked =
        this.#hooks.coreState().crossPostListDeliveriesByReceivingStream[receivingStreamPath];
      if (blocked?.sourceOffset === args.sourceOffset && blocked.status === "blocked") {
        this.#hooks.retryStore.delete(receivingStreamPath, args.sourceOffset);
      }
      console.error("sending cross-post list to receiving stream is blocked", {
        receivingStreamPath,
        ...args,
      });
    } catch (error) {
      if (!isDurableObjectLifecycleError(error)) throw error;
      const nextAttemptAt = this.#hooks.now() + 1_000;
      this.#hooks.retryStore.fail(receivingStreamPath, {
        sourceOffset: args.sourceOffset,
        attempt: args.attempt - 1,
        nextAttemptAt,
        error: args.error,
      });
      this.#hooks.armAlarm(nextAttemptAt);
    }
  }

  /** Build and send the source's complete current list for one receiving stream. */
  async #sendCurrentList(args: {
    receivingStreamPath: string;
    sourceOffset: number;
  }): Promise<StreamEvent | null> {
    const state = this.#hooks.coreState();
    const tracker = state.crossPostListDeliveriesByReceivingStream[args.receivingStreamPath];
    if (tracker?.sourceOffset !== args.sourceOffset) {
      this.#hooks.retryStore.delete(args.receivingStreamPath, args.sourceOffset);
      return null;
    }
    if (tracker.status !== "pending") return null;
    const sourceStreamId = state.streamId;
    const sourceStreamCreatedAt = state.createdAt;
    if (sourceStreamId === undefined || sourceStreamCreatedAt === undefined) {
      throw new Error("cannot send a cross-post list from an uninitialized stream");
    }

    const subscriptionsByKey: CrossPostListRecordedPayload["subscriptionsByKey"] = {};
    for (const [subscriptionKey, entry] of Object.entries(state.subscriptions.outbound.byKey)) {
      if (
        entry.configuration.receiver.action !== "cross-post" ||
        entry.configuration.receiver.receivingStreamPath !== args.receivingStreamPath
      ) {
        continue;
      }
      subscriptionsByKey[subscriptionKey] = {
        configuredAtSourceOffset: entry.configuredAtOffset,
        configuration: recordedSubscriptionForCrossPost(entry.configuration),
      };
    }

    const eventInput: StreamEventInput = {
      type: "events.iterate.com/stream/cross-post-list-recorded",
      idempotencyKey: internalStreamId(
        "cross-post-list-recorded",
        this.#hooks.projectId,
        this.#hooks.path,
        sourceStreamId,
        args.receivingStreamPath,
        args.sourceOffset,
      ),
      payload: {
        source: {
          projectId: this.#hooks.projectId,
          path: this.#hooks.path,
          streamId: sourceStreamId,
          streamCreatedAt: sourceStreamCreatedAt,
        },
        sourceOffset: args.sourceOffset,
        subscriptionsByKey,
      },
    };

    let receivingStreamEvent: StreamEvent;
    try {
      const remoteEvent = await withDeliveryTimeout(
        this.#hooks.recordCrossPostListOnReceivingStream(args.receivingStreamPath, eventInput),
        `sending cross-post list from ${this.#hooks.path}@${args.sourceOffset} to ${args.receivingStreamPath}`,
        { onLateResolve: disposeIgnoredRpcResult },
      );
      try {
        receivingStreamEvent = StreamEventSchema.parse(remoteEvent);
      } finally {
        disposeIgnoredRpcResult(remoteEvent);
      }
    } catch (error) {
      throw new Error(
        `sending cross-post list to "${args.receivingStreamPath}" failed: ${errorMessage(error)}`,
      );
    }

    const recorded = parseCommittedCoreEvent(
      receivingStreamEvent,
      "events.iterate.com/stream/cross-post-list-recorded",
    );
    const trackerAfterCall =
      this.#hooks.coreState().crossPostListDeliveriesByReceivingStream[args.receivingStreamPath];
    if (trackerAfterCall?.sourceOffset !== args.sourceOffset) {
      this.#hooks.retryStore.delete(args.receivingStreamPath, args.sourceOffset);
      return null;
    }
    const recordedSource = recorded.payload.source;
    const differentSourceLifetime =
      recordedSource.streamId !== sourceStreamId ||
      recordedSource.streamCreatedAt !== sourceStreamCreatedAt;
    if (
      differentSourceLifetime &&
      compareSourceListPosition(
        {
          streamId: sourceStreamId,
          streamCreatedAt: sourceStreamCreatedAt,
          sourceOffset: args.sourceOffset,
        },
        {
          source: {
            streamId: recordedSource.streamId,
            streamCreatedAt: recordedSource.streamCreatedAt,
          },
          sourceOffset: recorded.payload.sourceOffset,
        },
      ) <= 0
    ) {
      throw new SourceLifetimeConflictError(
        `receiving stream "${args.receivingStreamPath}" already records a newer lifetime of source "${this.#hooks.path}" (${recordedSource.streamId}, created ${recordedSource.streamCreatedAt}); reset the receiving stream before retrying because resend cannot succeed for the older lifetime (${sourceStreamId}, created ${sourceStreamCreatedAt})`,
      );
    }
    if (
      recorded.path !== args.receivingStreamPath ||
      recorded.payload.source.projectId !== this.#hooks.projectId ||
      recorded.payload.source.path !== this.#hooks.path ||
      recorded.payload.source.streamId !== sourceStreamId ||
      recorded.payload.source.streamCreatedAt !== sourceStreamCreatedAt ||
      recorded.payload.sourceOffset !== args.sourceOffset ||
      !jsonValuesEqual(recorded.payload.subscriptionsByKey, subscriptionsByKey)
    ) {
      throw new Error(
        `receiving stream "${args.receivingStreamPath}" returned subscriptions that do not match those sent by "${this.#hooks.path}"`,
      );
    }

    this.#hooks.appendCore({
      type: "events.iterate.com/stream/cross-post-list-confirmed",
      idempotencyKey: internalStreamId(
        "cross-post-list-confirmed",
        args.receivingStreamPath,
        sourceStreamId,
        args.sourceOffset,
      ),
      payload: { ...args, receivingStreamEvent: recorded },
    });
    this.#hooks.retryStore.delete(args.receivingStreamPath, args.sourceOffset);

    const current =
      this.#hooks.coreState().crossPostListDeliveriesByReceivingStream[args.receivingStreamPath];
    const stillCurrent =
      current?.sourceOffset === args.sourceOffset && current.status === "confirmed";
    const removedAndCurrent =
      current === undefined &&
      !Object.values(this.#hooks.coreState().subscriptions.outbound.byKey).some(
        (entry) =>
          entry.configuration.receiver.action === "cross-post" &&
          entry.configuration.receiver.receivingStreamPath === args.receivingStreamPath,
      );
    return stillCurrent || removedAndCurrent ? receivingStreamEvent : null;
  }

  /** Follow newer source changes until the source confirms the receiver's latest complete list. */
  async waitUntilConfirmed(
    receivingStreamPath: string,
  ): Promise<CommittedCrossPostListRecordedEvent> {
    for (;;) {
      const state = this.#hooks.coreState();
      const tracker = state.crossPostListDeliveriesByReceivingStream[receivingStreamPath];
      if (tracker === undefined) {
        const latest = this.#hooks.latestCrossPostListRecordedByReceiver(receivingStreamPath);
        if (latest === undefined) {
          throw new Error(
            `receiving stream "${receivingStreamPath}" has no recorded cross-post list`,
          );
        }
        return this.#receiverEventFromReceipt(latest, receivingStreamPath);
      }

      if (tracker.status === "confirmed") {
        const sourceStreamId = state.streamId;
        if (sourceStreamId === undefined) throw new Error("a configured stream has no stream ID");
        const sourceReceipt = this.#hooks.getEvent({
          idempotencyKey: internalStreamId(
            "cross-post-list-confirmed",
            receivingStreamPath,
            sourceStreamId,
            tracker.sourceOffset,
          ),
        });
        if (sourceReceipt === undefined) {
          throw new Error(
            `receiving stream "${receivingStreamPath}" is marked confirmed at source offset ${tracker.sourceOffset} without the matching source event`,
          );
        }
        return this.#receiverEventFromReceipt(
          sourceReceipt,
          receivingStreamPath,
          tracker.sourceOffset,
        );
      }

      if (tracker.status === "blocked") {
        throw crossPostListBlockedError({
          receivingStreamPath,
          attempts: tracker.attempts,
          lastError: tracker.error,
        });
      }

      const receivingStreamEvent = await this.#startOrJoin({
        receivingStreamPath,
        sourceOffset: tracker.sourceOffset,
      });
      if (receivingStreamEvent === null) continue;

      const recorded = parseCommittedCoreEvent(
        receivingStreamEvent,
        "events.iterate.com/stream/cross-post-list-recorded",
      );
      const current =
        this.#hooks.coreState().crossPostListDeliveriesByReceivingStream[receivingStreamPath];
      if (current === undefined) {
        const stillHasSubscriptions = Object.values(
          this.#hooks.coreState().subscriptions.outbound.byKey,
        ).some(
          (entry) =>
            entry.configuration.receiver.action === "cross-post" &&
            entry.configuration.receiver.receivingStreamPath === receivingStreamPath,
        );
        if (!stillHasSubscriptions) return recorded;
        throw new Error(
          `receiving stream "${receivingStreamPath}" lost its cross-post-list record while subscriptions still target it`,
        );
      }
      if (
        current.sourceOffset === recorded.payload.sourceOffset &&
        current.status === "confirmed"
      ) {
        return recorded;
      }
    }
  }

  #receiverEventFromReceipt(
    event: StreamEvent,
    receivingStreamPath: string,
    sourceOffset?: number,
  ): CommittedCrossPostListRecordedEvent {
    const sourceReceipt = parseCommittedCoreEvent(
      event,
      "events.iterate.com/stream/cross-post-list-confirmed",
    );
    if (
      sourceReceipt.payload.receivingStreamPath !== receivingStreamPath ||
      (sourceOffset !== undefined && sourceReceipt.payload.sourceOffset !== sourceOffset)
    ) {
      throw new Error(
        `cross-post-list record does not match receiving stream "${receivingStreamPath}"`,
      );
    }
    return sourceReceipt.payload.receivingStreamEvent;
  }
}
