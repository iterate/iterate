import { DurableObjectNameCodec, type DurableObjectAddress } from "../durable-object-names.ts";
import type { Stream } from "../../types.ts";
import type { ConfiguredStreamSubscriber } from "./engine/processors/core/contract.ts";

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
 * need to attach a configured processor host to a stream while preserving the
 * same subscription identity scheme everywhere.
 */
export function subscriptionConfiguredEvent(input: {
  address?: DurableObjectAddress;
  projectId: string | null;
  path: string;
  subscriberType: Exclude<ConfiguredStreamSubscriber["type"], "worker">;
}) {
  const address = input.address ?? {
    projectId: input.projectId,
    path: input.path,
    props: {},
  };
  const durableObjectName = DurableObjectNameCodec.stringify(address, { allowNullProjectId: true });
  return {
    type: "events.iterate.com/stream/subscription-configured" as const,
    payload: {
      subscriptionKey: `${input.subscriberType}:${durableObjectName}`,
      subscriber: {
        address,
        type: input.subscriberType,
      },
    },
  } satisfies Parameters<Stream["append"]>[0];
}
