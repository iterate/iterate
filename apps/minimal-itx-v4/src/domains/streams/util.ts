import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { Stream } from "../../types.ts";
import { durableObjectProcessorSubscriber } from "./engine/shared/callable-subscriber.ts";

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
 * Processor subscriptions are represented as stream facts, not imperative host
 * state. Domain processors and RPC bootstrap code use this helper when they
 * need to attach a named processor host to a stream while preserving the same
 * subscription identity scheme everywhere: `${processorName}:${hostName}`.
 * That identity lets appending the same configuration replace/reconcile the
 * existing outbound connection instead of creating duplicates.
 */
export function subscriptionConfiguredEvent(input: {
  projectId: string | null;
  path: string;
  bindingName: string;
  processorName: string;
}) {
  const durableObjectName = DurableObjectNameCodec.stringify(
    {
      projectId: input.projectId,
      path: input.path,
    },
    { allowNullProjectId: true },
  );
  return {
    type: "events.iterate.com/stream/subscription-configured" as const,
    payload: {
      subscriptionKey: `${input.processorName}:${durableObjectName}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: input.bindingName,
        durableObjectName,
        processorName: input.processorName,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}
