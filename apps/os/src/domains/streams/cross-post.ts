// Cross-posting: copying events between streams with provenance.
//
// THE LOCALITY RULE (streams README): a processor on stream A can only react
// to events ON stream A; reacting to stream B means copying B's events onto A.
// This module is the receiving half of that copy — the logic behind
// `Stream.ingest`, an ordinary push SINK (`(batch) => void`) that source
// streams address with `{ delivery: { mode: "push", expression: ["streams",
// ["get", targetPath], "ingest"] } }` (sugar: `crossPostTo`). Everything
// cross-post-specific lives here, in named receiver code, and the generic
// delivery spine knows none of it (selectors filter; receivers transform):
//
// - provenance: every hop appends itself to `source.crossPostedFrom`, so a
//   multi-hop route stays legible end to end;
// - loop protection: structural (never ingest an event whose chain already
//   contains this stream) with a hop cap as the backstop;
// - idempotency: keys derive from the SOURCE coordinate, so at-least-once
//   delivery collapses to exactly-once appends;
// - transforms: `params: { transform }` on the subscription is a JSONata
//   expression CONSTRUCTING the copied event's body from the original. It is
//   applied here, BEFORE provenance stamping — a transform can reshape the
//   body but can never forge or drop the chain. A transform that throws or
//   returns a non-object skips that event with an idempotent error fact; it
//   never wedges the subscription (the parse-poison posture from #1714).

import { z } from "zod";
import type { StreamPushEventBatch } from "./rpc-types.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import { compileJsonataExpression } from "./event-selector.ts";

type CrossPostProvenanceChain = NonNullable<NonNullable<StreamEvent["source"]>["crossPostedFrom"]>;

/**
 * Backstop cap on a cross-post provenance chain. The structural cycle guard
 * is the real protection; the cap only bounds acyclic relay graphs nobody
 * should build (a 5-hop relay is a design smell, not a use case).
 */
const MAX_CROSS_POST_HOPS = 5;

/** The receiver params `ingest` understands (the `params` bag on
 * `subscription-configured`). Loose: unknown keys are someone else's params. */
const IngestParams = z.looseObject({
  transform: z.string().trim().min(1).optional(),
});

/**
 * What an ingest transform may construct. Strict, so a typo'd key fails as a
 * recorded per-event error instead of silently vanishing from the copy.
 */
const IngestTransformResult = z.strictObject({
  type: z.string().trim().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function buildCrossPostAppendInput(args: {
  event: StreamEvent;
  crossPostedFrom: CrossPostProvenanceChain;
  idempotencyKey: string;
}): StreamEventInput {
  return {
    type: args.event.type,
    ...(args.event.payload === undefined ? {} : { payload: args.event.payload }),
    ...(args.event.metadata === undefined ? {} : { metadata: args.event.metadata }),
    source: { ...args.event.source, crossPostedFrom: args.crossPostedFrom },
    idempotencyKey: args.idempotencyKey,
  };
}

/**
 * Everything `Stream.ingest` appends for one delivered batch: the transformed,
 * provenance-stamped copies plus any per-event transform-failure facts. Pure —
 * the Stream Durable Object appends the result in its own synchronous turn.
 */
export function buildIngestAppendInputs(
  batch: StreamPushEventBatch,
  self: { projectId: string | null; path: string },
): StreamEventInput[] {
  const params = IngestParams.parse(batch.configuredEvent.payload?.params ?? {});
  const transform =
    params.transform === undefined ? undefined : compileJsonataExpression(params.transform);

  const inputs: StreamEventInput[] = [];
  for (const event of batch.events) {
    const chain = event.source?.crossPostedFrom ?? [];
    if (chain.length >= MAX_CROSS_POST_HOPS) continue;
    const hop = {
      subscriptionKey: batch.subscriptionKey,
      createdAt: event.createdAt,
      offset: event.offset,
      path: event.path,
      projectId: batch.projectId,
      type: event.type,
    };
    const crossPostedFrom: CrossPostProvenanceChain = [...chain, hop];
    // Structural loop protection: never ingest an event whose provenance
    // chain already contains this stream (including the source hop itself
    // when someone wires a stream to ingest into itself).
    const selfOnChain = crossPostedFrom.some(
      (entry) => entry.projectId === self.projectId && entry.path === self.path,
    );
    if (selfOnChain) continue;

    let body: Pick<StreamEvent, "type" | "payload" | "metadata"> = event;
    if (transform !== undefined) {
      try {
        const produced = IngestTransformResult.parse(transform.evaluate(event));
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
        // Deterministic per-event failure: skipping with a durable record is
        // the only non-wedging option (throwing would park the SOURCE
        // subscription on an event that will never transform differently).
        inputs.push({
          type: "events.iterate.com/stream/error-occurred",
          idempotencyKey: `ingest-transform-failed:${batch.subscriptionKey}:${event.path}@${event.offset}`,
          payload: {
            message: `ingest transform for subscription "${batch.subscriptionKey}" failed on ${event.path}@${event.offset}: ${String(error)}`,
          },
        });
        continue;
      }
    }

    inputs.push(
      buildCrossPostAppendInput({
        event: { ...event, ...body },
        crossPostedFrom,
        // At-least-once delivery collapses to exactly-once appends: the key
        // is derived from the SOURCE coordinate, so a redelivered batch
        // re-appends nothing.
        idempotencyKey: `xpost:${batch.subscriptionKey}:${batch.projectId ?? "global"}:${event.path}:${event.offset}`,
      }),
    );
  }
  return inputs;
}
