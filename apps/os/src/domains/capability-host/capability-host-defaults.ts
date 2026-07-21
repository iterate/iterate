// Capability-host creation policy: THE birth batch for one capability scope.
// Every explicit `capabilityHosts.get(path).create(payload)` and every saga
// that births a scope (agent birth, the project root bootstrap) appends
// exactly this batch, so the idempotency keys collide by design: whoever
// appends first wins and every retry dedupes.

import type { z } from "zod";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import {
  CapabilityHostProcessorContract,
  capabilityFallbackForScope,
} from "./capability-host-processor-contract.ts";

/** The `capability-host/created` payload — the scope's birth certificate. */
export type CapabilityHostCreateInput = z.input<
  (typeof CapabilityHostProcessorContract.events)["events.iterate.com/capability-host/created"]["payloadSchema"]
>;

/**
 * The complete atomic creation batch for one capability-host scope: the
 * `capability-host/created` birth certificate plus the subscription that arms
 * the scope's own processor. Append the whole array in ONE `stream.append`
 * call — the batch commits atomically, so a scope can never exist half-born.
 *
 * The created event's idempotency key is payload-free on purpose: a repeated
 * create with the identical payload dedupes and resolves, while a create over
 * an EXISTING scope with a different payload is rejected by the stream's
 * same-key-different-body rule — the loud duplicate-create failure.
 */
export function capabilityHostCreationEvents(input: {
  /** Scope path (normalized): "/" is the project root, "/agents/bla" an agent scope. */
  path: string;
  /** Birth certificate; defaults to `{}` config with the standard one-hop
   * fallback to the project root host (null at the root itself). */
  payload?: CapabilityHostCreateInput;
  projectId: string;
}) {
  const { path, projectId } = input;
  const durableObjectName = DurableObjectNameCodec.stringify({ projectId, path });
  return [
    CapabilityHostProcessorContract.buildEvent({
      type: "events.iterate.com/capability-host/created",
      idempotencyKey: `capability-host/created:${projectId}:${path}`,
      // The root host ends resolution; every other scope journals a one-hop
      // fallback straight to it.
      payload: input.payload ?? { config: {}, fallback: capabilityFallbackForScope(path) },
    }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${CapabilityHostProcessorContract.slug}`,
      processor: ["capabilityHosts", ["get", path], "processor"],
      processorSlug: CapabilityHostProcessorContract.slug,
    }),
  ];
}
