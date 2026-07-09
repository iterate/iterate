import type { ItxExpression } from "../../itx/expression.ts";
import { CoreProcessorContract } from "./core-processor-contract.ts";
import { buildEvent } from "./processor-contracts.ts";

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
 * `processor` is the itx expression naming the host's processor NODE on the
 * ordinary domain surface — `["agents", ["get", path], "processor"]`,
 * `["repos", ["get", path], "processor"]`, the project root's own
 * `["processor"]`, `["email", "processor"]`, … — and the built delivery
 * appends the wake door (`"wakeStreamSubscriber"`) to it. Each call site
 * states its own domain address; this helper only owns the shared payload
 * shape. The event itself remains the public interface: callers may append it
 * directly.
 *
 * Note what the expression does NOT carry: a projectId. Persisted config is a
 * NAME; the delivering stream re-derives authority from its own itx root at
 * dial time, so the host is always resolved in the stream's own project (or
 * the deployment-global scope for `projectId: null` streams) — persisted
 * config cannot smuggle cross-project reach, structurally.
 *
 * The default `subscriptionKey` is `${durableObjectName}#${processorSlug}` and
 * should be treated as opaque. `idempotencyKey` is an optional pass-through for
 * unusual repair/debug flows; normal bootstrap call sites intentionally omit it
 * so repeated configuration appends remain visible in the event log while
 * debugging failed subscription setup.
 */
export function buildDurableObjectProcessorSubscriptionConfiguredEvent(input: {
  durableObjectName: string;
  idempotencyKey?: string;
  /** Itx expression to the host's processor node (the wake door is appended). */
  processor: ItxExpression;
  processorSlug: string;
  subscriptionKey?: string;
}) {
  return buildEvent({
    contract: CoreProcessorContract,
    event: {
      type: "events.iterate.com/stream/subscription-configured",
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      payload: {
        subscriptionKey:
          input.subscriptionKey ?? `${input.durableObjectName}#${input.processorSlug}`,
        delivery: {
          mode: "wake",
          expression: [...input.processor, "wakeStreamSubscriber"],
          // processorSlug rides the delivery explicitly; the wake request
          // carries it so multi-processor hosts resolve without parsing
          // anything out of the (opaque) subscription key.
          processorSlug: input.processorSlug,
        },
      },
    },
  });
}
