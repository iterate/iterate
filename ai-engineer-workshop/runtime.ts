import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import {
  createEventsClient as createBaseEventsClient,
  eventsContract,
} from "../apps/events-contract/src/sdk.ts";
import type { EventsORPCClient } from "../apps/events-contract/src/sdk.ts";

export {
  eventsContract,
  getDiscoveredStreamPath,
  matchesStreamPattern,
  normalizeStreamPattern,
  type EventsORPCClient,
  PushSubscriptionProcessorRuntime,
  PullSubscriptionProcessorRuntime,
  PullSubscriptionPatternProcessorRuntime,
  defineBuiltinProcessor,
  defineProcessor,
  EventInput,
  GenericEventInput,
  type BuiltinProcessor,
  type Processor,
  type ProcessorAppendInput,
  type RelativeStreamPath,
} from "../apps/events-contract/src/sdk.ts";
export type { Event, EventType, JSONObject, StreamPath } from "../apps/events-contract/src/sdk.ts";

const iterateProjectHeader = "x-iterate-project";
const defaultBaseUrl = "https://events.iterate.com";

export function createEventsClient({
  baseUrl = defaultBaseUrl,
  projectSlug,
}: {
  baseUrl?: string;
  projectSlug?: string;
} = {}): EventsORPCClient {
  if (projectSlug == null) {
    return createBaseEventsClient(baseUrl);
  }

  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
      fetch: (request: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
        headers.set(iterateProjectHeader, projectSlug);
        return fetch(request, { ...init, headers });
      },
    }),
  ) as EventsORPCClient;
}
