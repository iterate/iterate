import { DurableObjectNameCodec, type DurableObjectAddress } from "../durable-object-names.ts";
import {
  CoreProcessorContract,
  type ConfiguredStreamSubscriber,
} from "./engine/processors/core/contract.ts";
import { buildEvent } from "./engine/shared/stream-processors.ts";

/**
 * Stream capabilities expose `.at(relativePath)` to code that should stay
 * scoped beneath the stream it already holds. This helper is the shared guard
 * for that capability boundary: relative paths can descend into children or
 * walk back up within the held stream's root, while attempts to escape above it
 * fail before a new Durable Object name is minted.
 */
export function resolveStreamPath(basePath: string, streamPath: string): string {
  const segments = streamPath.startsWith("/") ? [] : basePath.split("/").filter(Boolean);
  for (const segment of streamPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `stream path "${streamPath}" escapes the stream root (resolved from "${basePath}")`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * Builds the public `events.iterate.com/stream/subscription-configured` fact
 * for a processor hosted by one of this app's Durable Objects.
 *
 * This helper exists because that event has a deliberately involved payload:
 * it must carry the opaque durable subscription key, a typed subscriber target
 * (`agent`, `itx`, `project`, or `repo`), and the parsed Durable Object address
 * the Stream Durable Object will later wake. The event itself remains the public
 * interface: callers may append it directly, and this helper is only a
 * convenience for the bootstrap paths that would otherwise duplicate the same
 * shape in several places.
 *
 * Validation and trust checks do not live here. A caller that can append to a
 * stream can always hand-write this event, so project/scope validation belongs
 * in the Stream Durable Object's append/reconcile path. The helper only parses
 * the target name and reuses the core processor contract via `buildEvent(...)`
 * so ordinary call sites get the same payload typing and Zod validation as any
 * other contract-owned event.
 *
 * The default `subscriptionKey` is `${durableObjectName}#${processorSlug}` and
 * should be treated as opaque. `idempotencyKey` is an optional pass-through for
 * unusual repair/debug flows; normal bootstrap call sites intentionally omit it
 * so repeated configuration appends remain visible in the event log while
 * debugging failed subscription setup. The subscriber payload shape is likely
 * to change again as stream subscriptions settle, so keep new subscription
 * setup code funneled through this helper unless it is intentionally testing
 * hand-authored public events.
 */
export function buildDurableObjectProcessorSubscriptionConfiguredEvent(input: {
  durableObjectName: string;
  idempotencyKey?: string;
  processorSlug: string;
  subscriberType: Exclude<ConfiguredStreamSubscriber["type"], "worker">;
  subscriptionKey?: string;
}) {
  const address = DurableObjectNameCodec.parse(input.durableObjectName, {
    allowNullProjectId: true,
  }) satisfies DurableObjectAddress;

  return buildEvent({
    contract: CoreProcessorContract,
    event: {
      type: "events.iterate.com/stream/subscription-configured",
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      payload: {
        subscriptionKey:
          input.subscriptionKey ?? `${input.durableObjectName}#${input.processorSlug}`,
        subscriber: {
          address,
          type: input.subscriberType,
        },
      },
    },
  });
}
