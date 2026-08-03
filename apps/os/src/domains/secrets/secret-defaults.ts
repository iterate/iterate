// Secret creation policy: THE birth batch for one secret stream.
//
// Unlike the other domains, the public door (`secrets.get(path).create`)
// does not append this batch itself — it delegates to the Secret Durable
// Object, which owns real birth semantics: material encryption bound to the
// exact commit offset, and a compare-and-append that serializes concurrent
// creates. The DO is therefore the only appender of this batch; the builder
// keeps the batch shape (created + processor subscription, one atomic
// append) uniform with every other domain.
//
// Duplicate-create semantics: the created event's idempotency key is
// payload-free, but the stream's same-key-different-body rejection CANNOT
// police secret payloads — `encryptedMaterial` is AES-GCM ciphertext with a
// fresh IV per encryption, so even an identical logical retry produces a
// different body. The Secret DO enforces loudness itself: a create over an
// existing secret compares the comparable birth policy (egress, refresh,
// visibility) and throws on a mismatch, while MATERIAL differences resolve
// as a keep-existing no-op (material is write-only and rotates through
// `update()`; the ensure-create-then-reveal pairing flow depends on this).

import type { z } from "zod";
import type { StreamEventInput } from "iterate/processors";
import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";

/** The `secret/created` payload — the secret's birth certificate (material already encrypted by the DO). */
type SecretCreatedPayload = z.input<
  (typeof SecretProcessorContract.events)["events.iterate.com/secret/created"]["payloadSchema"]
>;

/**
 * The complete atomic creation batch for one secret: the `secret/created`
 * birth certificate plus the subscription that arms the secret's own
 * processor. Append the whole array in ONE `stream.append` call.
 */
export function secretCreationEvents(input: {
  /**
   * Compare-and-append rider for the created event: material encryption is
   * authenticated against this exact commit offset, so a concurrent append
   * fails the create instead of committing a blob that can never decrypt.
   */
  offset?: number;
  path: string;
  payload: SecretCreatedPayload;
  projectId: string;
}) {
  const { offset, path, payload, projectId } = input;
  return [
    {
      ...SecretProcessorContract.buildEvent({
        type: "events.iterate.com/secret/created",
        idempotencyKey: `secret/created:${projectId}:${path}`,
        payload,
      }),
      ...(offset === undefined ? {} : { offset }),
    } as StreamEventInput,
    buildFacetProcessorSubscriptionConfiguredEvent({
      idempotencyKey: `stream/subscription-configured:${SecretProcessorContract.slug}`,
      processorSlug: SecretProcessorContract.slug,
    }),
  ];
}
