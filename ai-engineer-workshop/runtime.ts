import { eventsContract } from "../apps/events-contract/src/sdk.ts";
import type { EventsORPCClient } from "../apps/events-contract/src/sdk.ts";
import { createWorkshopEventsClient } from "./events-client.ts";

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

const defaultBaseUrl = "https://events.iterate.com";

export function createEventsClient({
  baseUrl = defaultBaseUrl,
  projectSlug,
}: {
  baseUrl?: string;
  projectSlug?: string;
} = {}): EventsORPCClient {
  return createWorkshopEventsClient({ baseUrl, projectSlug });
}
