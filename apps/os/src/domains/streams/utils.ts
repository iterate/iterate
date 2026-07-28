import type { ItxExpression } from "../../itx/expression.ts";
import { CoreProcessorContract } from "./core-processor-contract.ts";

export { resolveStreamPath } from "iterate/processors";

/**
 * Builds the public `events.iterate.com/stream/subscription-configured` event
 * for a processor hosted by one of this app's Durable Objects.
 *
 * `processor` is the itx expression naming the host's processor NODE on the
 * ordinary domain surface — `["agents", ["get", path], "processor"]`,
 * `["repos", ["get", path], "processor"]`, the project root's own
 * `["processor"]`, `["email", "processor"]`, … — and the built delivery
 * appends the method name (`"wakeStreamProcessor"`) to it. Each call site
 * states its own domain address; this helper only owns the shared payload
 * shape. The event itself remains the public interface: callers may append it
 * directly.
 *
 * Note what the expression does NOT carry: a projectId. Persisted config is a
 * NAME; the delivering stream re-derives authority from its own itx root at
 * call time, so the host is always resolved in the stream's own project (or
 * the deployment-global scope for `projectId: null` streams) — persisted
 * config cannot smuggle cross-project reach, structurally.
 *
 * The default `subscriptionKey` is `${durableObjectName}#${processorSlug}` and
 * should be treated as opaque. Birth-batch call sites pass a stable
 * `idempotencyKey`, so an ambiguous create retry reuses the same configuration
 * event. Omit it only when a caller deliberately wants every reconfiguration
 * attempt to remain visible as a new event.
 */
export function buildHostedProcessorSubscriptionConfiguredEvent(input: {
  durableObjectName: string;
  idempotencyKey?: string;
  /** Itx expression to the host's processor node (the wake door is appended). */
  processor: ItxExpression;
  processorSlug: string;
  subscriptionKey?: string;
}) {
  return CoreProcessorContract.buildEvent({
    type: "events.iterate.com/stream/subscription-configured",
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    payload: {
      subscriptionKey: input.subscriptionKey ?? `${input.durableObjectName}#${input.processorSlug}`,
      receiver: {
        action: "processor-wake",
        expression: [...input.processor, "wakeStreamProcessor"],
        // processorSlug rides the delivery explicitly; the wake request
        // carries it so multi-processor hosts resolve without parsing
        // anything out of the opaque subscription key.
        processorSlug: input.processorSlug,
      },
    },
  });
}
