// Appending matching source events to another stream with `source.copiedFrom`.
//
// A processor on stream A can only react
// to events ON stream A; reacting to stream B means receiving B's events on A.
// This module performs the receiving half of that operation: the logic behind
// `StreamDurableObject.receiveCopiedEvents`, configured by a direct
// `{ receiver: { action: "copy-to-stream", receivingStreamPath } }` subscription. The shared source-side
// delivery code knows none of these receiving details (filters select;
// receivers transform):
//
// - source history: every send appends itself to `source.copiedFrom`, so a
//   multi-stream chain stays legible end to end;
// - cycle prevention: never accept an event whose chain already contains this
//   stream, with a hop cap as the backstop;
// - transport-retry deduplication: keys use the source project, path, stream
//   lifetime ID, subscription, cursor-changing event, and event offset. A retry
//   within one send run appends nothing; a recreated source, deliberate seek,
//   or same-key replacement may append the same source offset again;
// - transforms: `receiver.transform` on the subscription is a JSONata
//   expression CONSTRUCTING the received event's body from the original. It is
//   applied here, BEFORE adding `source.copiedFrom` — a transform can reshape
//   the body but can never forge or drop the chain. A transform that throws or
//   returns a non-object rejects the batch; copies always use the
//   halt-on-failure policy because advancing would create a gap in the receiving stream.

import { z } from "zod";
import {
  jsonValuesEqual,
  MAX_COPIED_FROM_HOPS,
  StreamEvent as StreamEventSchema,
  StreamReceiverUnavailableError,
} from "iterate/processors";
import type {
  StreamDeliveryBatch,
  StreamEvent,
  StreamEventInput,
  CopyReceipt,
} from "iterate/processors";
import type {
  CoreProcessorState,
  SubscriptionConfiguredPayload,
} from "./core-processor-contract.ts";
import {
  parseCommittedCoreEvent,
  recordedSubscriptionForCopy,
  subscriptionKeyForConfiguredEvent,
} from "./core-processor-contract.ts";
import { compileJsonataExpression } from "./event-filter.ts";
import { errorMessage, internalStreamId } from "./stream-delivery-utils.ts";

type CopiedFromChain = NonNullable<NonNullable<StreamEvent["source"]>["copiedFrom"]>;

/**
 * What a copy transform may construct. Strict, so a typo'd key
 * rejects delivery instead of silently vanishing.
 */
const CopyTransformResult = z.strictObject({
  type: z.string().trim().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Validate one source delivery against the receiver's current reduced state,
 * then construct every event that must be appended in the receiver's single
 * synchronous turn. Malformed batches throw a plain Error; a missing or stale
 * recorded subscription throws StreamReceiverUnavailableError because the sender's
 * retry policy distinguishes those outcomes. The committed configuration in
 * the batch is evidence only: transforms and delivery settings always come
 * from the receiver's recorded state.
 */
export function buildCopyAppends({
  batch,
  self,
  source,
}: {
  batch: StreamDeliveryBatch;
  self: { projectId: string | null; path: string };
  source: CoreProcessorState["subscriptions"]["inbound"]["bySourcePath"][string] | undefined;
}): { inputs: StreamEventInput[]; receipt: CopyReceipt } {
  validateStreamDeliveryBatch(batch);

  const configuredEvent = parseCommittedCoreEvent(
    StreamEventSchema.parse(batch.configuredEvent),
    "events.iterate.com/stream/subscription-configured",
  );
  const receiver = configuredEvent.payload.receiver;
  const recordedSubscription = source?.byKey[batch.subscriptionKey];
  const configuredSubscriptionKey = subscriptionKeyForConfiguredEvent(configuredEvent);
  const expectedRecordedSubscription =
    receiver.action === "copy-to-stream"
      ? recordedSubscriptionForCopy(configuredEvent.payload)
      : undefined;
  if (
    configuredEvent.path !== batch.path ||
    configuredEvent.offset !== recordedSubscription?.configuredAtSourceOffset ||
    configuredSubscriptionKey !== batch.subscriptionKey ||
    receiver.action !== "copy-to-stream" ||
    receiver.receivingStreamPath !== self.path ||
    source?.source.projectId !== batch.projectId ||
    source?.source.streamId !== batch.streamId ||
    source?.source.streamCreatedAt !== batch.streamCreatedAt ||
    batch.cursorChangedAtSourceOffset < configuredEvent.offset ||
    expectedRecordedSubscription === undefined ||
    !jsonValuesEqual(expectedRecordedSubscription, recordedSubscription.configuration)
  ) {
    throw new StreamReceiverUnavailableError(
      `copy receiver ${self.path} has no current subscription from ${batch.path}#${batch.subscriptionKey}@${configuredEvent.offset}`,
    );
  }

  const { inputs: receivedEventInputs, dropped } = buildCopyAppendInputs(batch, self, {
    action: "copy-to-stream",
    receivingStreamPath: self.path,
    delivery: recordedSubscription.configuration.delivery,
    ...(recordedSubscription.configuration.transform === undefined
      ? {}
      : { transform: recordedSubscription.configuration.transform }),
  });
  const suppressionEvents: StreamEventInput[] = dropped.map(({ offset, reason }) => ({
    type: "events.iterate.com/stream/copied-events-dropped",
    idempotencyKey: internalStreamId(
      "copy-event-dropped",
      batch.projectId,
      batch.path,
      batch.streamId,
      batch.subscriptionKey,
      batch.cursorChangedAtSourceOffset,
      offset,
    ),
    payload: {
      source: {
        projectId: batch.projectId,
        path: batch.path,
        streamId: batch.streamId,
        streamCreatedAt: batch.streamCreatedAt,
      },
      subscriptionKey: batch.subscriptionKey,
      reason,
      count: 1,
      firstOffset: offset,
      lastOffset: offset,
    },
  }));

  return {
    inputs: [...receivedEventInputs, ...suppressionEvents],
    receipt: { accepted: receivedEventInputs.length, dropped },
  };
}

function validateStreamDeliveryBatch(batch: StreamDeliveryBatch): void {
  if (batch.events.length === 0) {
    throw new Error("copy batches must contain at least one event");
  }
  if (!z.uuid().safeParse(batch.streamId).success) {
    throw new Error("copy batch has an invalid source stream ID");
  }
  if (!Number.isFinite(Date.parse(batch.streamCreatedAt))) {
    throw new Error("copy batch has an invalid source stream creation time");
  }
  if (!Number.isSafeInteger(batch.streamMaxOffset) || batch.streamMaxOffset < 1) {
    throw new Error("copy batch has an invalid source stream maximum offset");
  }
  if (
    !Number.isSafeInteger(batch.cursorChangedAtSourceOffset) ||
    batch.cursorChangedAtSourceOffset < 1 ||
    batch.cursorChangedAtSourceOffset > batch.streamMaxOffset
  ) {
    throw new Error("copy batch has an invalid cursor-control event offset");
  }

  let previousEventOffset = 0;
  for (const event of batch.events) {
    if (
      event.path !== batch.path ||
      !Number.isSafeInteger(event.offset) ||
      event.offset <= previousEventOffset ||
      event.offset > batch.streamMaxOffset
    ) {
      throw new Error("copy batch events must be ordered source-stream events");
    }
    previousEventOffset = event.offset;
  }
}

// A received event is a new event: `ephemeral` deliberately does not
// propagate. The source policy decides whether a transient source row is
// eligible; the receiver commits a durable result either way. Source
// offsets are descriptive, never dereferenced, so source-row eviction leaves
// no dangling reads.
function buildCopyAppendInput(args: {
  event: StreamEvent;
  copiedFrom: CopiedFromChain;
  idempotencyKey: string;
}): StreamEventInput {
  return {
    type: args.event.type,
    ...(args.event.payload === undefined ? {} : { payload: args.event.payload }),
    ...(args.event.metadata === undefined ? {} : { metadata: args.event.metadata }),
    source: { ...args.event.source, copiedFrom: args.copiedFrom },
    idempotencyKey: args.idempotencyKey,
  };
}

/**
 * Everything `StreamDurableObject.receiveCopiedEvents` appends for one delivered batch.
 * Pure — the Stream Durable Object appends the transformed copies with
 * `source.copiedFrom` in its own synchronous turn.
 */
function buildCopyAppendInputs(
  batch: StreamDeliveryBatch,
  self: { projectId: string | null; path: string },
  receiver: Extract<SubscriptionConfiguredPayload["receiver"], { action: "copy-to-stream" }>,
): { inputs: StreamEventInput[]; dropped: CopyReceipt["dropped"] } {
  const transformSource = receiver.transform;
  const transform =
    transformSource === undefined ? undefined : compileJsonataExpression(transformSource);

  const inputs: StreamEventInput[] = [];
  const dropped: CopyReceipt["dropped"] = [];
  for (const event of batch.events) {
    const chain = event.source?.copiedFrom ?? [];
    const hop = {
      subscriptionKey: batch.subscriptionKey,
      streamId: batch.streamId,
      streamCreatedAt: batch.streamCreatedAt,
      cursorChangedAtSourceOffset: batch.cursorChangedAtSourceOffset,
      createdAt: event.createdAt,
      offset: event.offset,
      path: event.path,
      projectId: batch.projectId,
      type: event.type,
    };
    const copiedFrom: CopiedFromChain = [...chain, hop];
    // Never accept an event whose `source.copiedFrom` chain already
    // contains this stream (including the source hop itself
    // when a chain of streams sends it back into itself).
    const selfOnChain = copiedFrom.some(
      (entry) => entry.projectId === self.projectId && entry.path === self.path,
    );
    if (selfOnChain) {
      dropped.push({ offset: event.offset, reason: "cycle" });
      continue;
    }
    if (chain.length >= MAX_COPIED_FROM_HOPS) {
      // This event can never be copied, which is different from a receiver failure:
      // retrying the same immutable provenance can never make it deliverable.
      dropped.push({ offset: event.offset, reason: "hop-limit" });
      continue;
    }

    let body: Pick<StreamEvent, "type" | "payload" | "metadata"> = event;
    if (transform !== undefined) {
      try {
        const produced = CopyTransformResult.parse(transform.evaluate(event));
        body = {
          type: produced.type ?? event.type,
          ...(produced.payload === undefined
            ? event.payload === undefined
              ? {}
              : { payload: event.payload }
            : { payload: produced.payload }),
          ...(produced.metadata === undefined
            ? event.metadata === undefined
              ? {}
              : { metadata: event.metadata }
            : { metadata: produced.metadata }),
        };
      } catch (error) {
        throw new Error(
          `copy transform for subscription "${batch.subscriptionKey}" failed on ${event.path}@${event.offset}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }

    inputs.push(
      buildCopyAppendInput({
        event: { ...event, ...body },
        copiedFrom,
        // At-least-once transport retries collapse within one cursor epoch.
        // A deliberate seek or same-key replacement changes the epoch and may
        // replay this same source coordinate as a new copied event.
        idempotencyKey: internalStreamId(
          "copy",
          batch.subscriptionKey,
          batch.cursorChangedAtSourceOffset,
          batch.projectId,
          event.path,
          batch.streamId,
          event.offset,
        ),
      }),
    );
  }
  return { inputs, dropped };
}
