// Appending matching source events to another stream with `source.copiedFrom`.
//
// A processor on stream A can only react
// to events ON stream A; reacting to stream B means receiving B's events on A.
// This module performs the receiving half of that operation: the logic behind
// `StreamDurableObject.receiveCopiedEvents`, configured by a direct
// `{ receiver: { action: "copy-to-stream", receivingStreamPath } }` subscription. The shared source-side
// delivery code knows none of these receiving details:
//
// - source history: every send appends itself to `source.copiedFrom`, so a
//   multi-stream chain stays legible end to end;
// - the inbound fence: every batch carries the stamp of the source lifetime
//   and config generation that produced it, and the receiver rejects a stamp
//   strictly older than the one it last accepted for the same
//   (source path, subscription key) — so a destructively-recreated stale
//   source, or an in-flight batch from a superseded config generation, cannot
//   land after its replacement started delivering;
// - cycle prevention: never accept an event whose chain already contains this
//   stream, with a hop cap as the backstop. Dropped events are acknowledged
//   (skip-not-defer, like a filter miss) and audited by ONE idempotent
//   `stream/error-occurred` on the receiving stream;
// - transport-retry deduplication: keys use the source project, path, stream
//   lifetime ID, subscription, cursor-changing event, and event offset. A retry
//   within one send run appends nothing; a recreated source, deliberate seek,
//   or same-key replacement may append the same source offset again;
// - transforms: the subscription's optional `jsonataTransform` is a JSONata
//   expression CONSTRUCTING the received event's body from the original. It is
//   applied here, BEFORE the platform stamps `source.copiedFrom` and the
//   source-coordinate idempotency key — a transform can reshape the body but
//   can never forge or drop the chain, and its output cannot affect
//   deduplication. A transform that throws or returns a non-object rejects the
//   batch; copies always use the halt-on-failure policy because advancing
//   would create a gap in the receiving stream. A transformed
//   `events.iterate.com/stream/*` type stays inert data like any copied
//   control event: the stamped provenance is what the core processor's
//   canonicalize/validate/reduce guards key on.

import { z } from "zod";
import { MAX_COPIED_FROM_HOPS, StreamEvent as StreamEventSchema } from "iterate/processors";
import type {
  StreamDeliveryBatch,
  StreamEvent,
  StreamEventInput,
  CopyReceipt,
} from "iterate/processors";
import type { CoreProcessorState } from "./core-processor-contract.ts";
import {
  parseCommittedCoreEvent,
  subscriptionNameForConfiguredEvent,
} from "./core-processor-contract.ts";
import { compareSourceStamp } from "./core-processor.ts";
import { applyJsonataTransform } from "./event-filter.ts";
import { internalStreamId } from "./stream-delivery-utils.ts";

type CopiedFromChain = NonNullable<NonNullable<StreamEvent["source"]>["copiedFrom"]>;

/**
 * Validate one source delivery against the receiver's passive inbound records,
 * then construct every event that must be appended in the receiver's single
 * synchronous turn. Malformed, mis-addressed, or stale-stamped batches throw a
 * plain Error: a stale stamp can never become deliverable by retrying, so the
 * sender's ladder is allowed to burn out and halt on it.
 */
export function buildCopyAppends({
  batch,
  self,
  inbound,
}: {
  batch: StreamDeliveryBatch;
  self: { projectId: string | null; path: string };
  inbound: CoreProcessorState["subscriptions"]["inbound"]["bySourcePath"][string] | undefined;
}): { inputs: StreamEventInput[]; receipt: CopyReceipt } {
  validateStreamDeliveryBatch(batch);

  const configuredEvent = parseCommittedCoreEvent(
    StreamEventSchema.parse(batch.configuredEvent),
    "events.iterate.com/stream/subscription-configured",
  );
  const receiver = configuredEvent.payload.receiver;
  if (
    configuredEvent.path !== batch.path ||
    subscriptionNameForConfiguredEvent(configuredEvent) !== batch.name ||
    receiver.action !== "copy-to-stream" ||
    receiver.receivingStreamPath !== self.path ||
    batch.cursorChangedAtSourceOffset < configuredEvent.offset
  ) {
    throw new Error(
      `copy batch from ${batch.path}#${batch.name} does not address receiver ${self.path}`,
    );
  }

  // The passive fence: accept an equal-or-newer stamp; reject strictly older.
  // The reducer updates the record from the committed events, so the fence
  // needs no configure-time handshake and replay reconstructs it identically.
  const recorded = inbound?.[batch.name];
  if (recorded && compareSourceStamp(batch, recorded) < 0) {
    throw new Error(
      `copy receiver ${self.path} already accepted a newer delivery for ${batch.path}#${batch.name} ` +
        `(recorded source lifetime ${recorded.streamId} created ${recorded.streamCreatedAt}, ` +
        `config generation ${recorded.cursorChangedAtSourceOffset}); this stale batch can never land`,
    );
  }

  const inputs: StreamEventInput[] = [];
  const droppedOffsets: number[] = [];
  for (const event of batch.events) {
    const chain = event.source?.copiedFrom ?? [];
    const hop = {
      name: batch.name,
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
    // when a chain of streams sends it back into itself). A drop is a
    // terminal acknowledgement — retrying the same immutable provenance can
    // never make the event deliverable — so the receiver skips past it.
    const selfOnChain = copiedFrom.some(
      (entry) => entry.projectId === self.projectId && entry.path === self.path,
    );
    if (selfOnChain || chain.length >= MAX_COPIED_FROM_HOPS) {
      droppedOffsets.push(event.offset);
      continue;
    }

    // The transform runs after the drop checks (a dropped event's transform
    // never evaluates, and the hop above recorded the ORIGINAL type) and
    // before the platform-owned fields below, so it can only shape
    // type/payload/metadata. A throw here rejects the whole batch into the
    // sender's ladder — copies halt on a repeatedly failing event.
    const shaped = applyJsonataTransform("copy", batch.name, receiver.jsonataTransform, event);

    // A received event is a new event: `ephemeral` deliberately does not
    // propagate. Source offsets are descriptive, never dereferenced, so
    // source-row eviction leaves no dangling reads.
    inputs.push({
      type: shaped.type,
      ...(shaped.payload && { payload: shaped.payload }),
      ...(shaped.metadata && { metadata: shaped.metadata }),
      // Provenance is stamped AFTER the transform, from the platform's own
      // hop record — a transform can never forge or drop the chain.
      source: { ...event.source, copiedFrom },
      // At-least-once transport retries collapse within one cursor epoch.
      // A deliberate seek or same-key replacement changes the epoch and may
      // replay this same source coordinate as a new copied event. Keyed by
      // source coordinates only: transform output cannot affect dedupe.
      idempotencyKey: internalStreamId(
        "copy",
        batch.name,
        batch.cursorChangedAtSourceOffset,
        batch.projectId,
        event.path,
        batch.streamId,
        event.offset,
      ),
    });
  }

  if (droppedOffsets.length) {
    const firstOffset = droppedOffsets[0]!;
    const lastOffset = droppedOffsets.at(-1)!;
    inputs.push({
      type: "events.iterate.com/stream/error-occurred",
      idempotencyKey: internalStreamId(
        "copy-drop",
        batch.projectId,
        batch.path,
        batch.streamId,
        batch.name,
        batch.cursorChangedAtSourceOffset,
        firstOffset,
        lastOffset,
      ),
      payload: {
        message:
          `dropped ${droppedOffsets.length} copied event(s) from "${batch.path}" subscription ` +
          `"${batch.name}" (source offsets ${firstOffset}-${lastOffset}): their ` +
          `stream-copy path already contains this stream or reached ${MAX_COPIED_FROM_HOPS} hops`,
      },
    });
  }

  return { inputs, receipt: { acknowledged: batch.events.length } };
}

function validateStreamDeliveryBatch(batch: StreamDeliveryBatch): void {
  if (!batch.events.length) {
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
