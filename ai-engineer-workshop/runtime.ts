import {
  PullSubscriptionPatternProcessorRuntime as BasePullSubscriptionPatternProcessorRuntime,
  eventsContract,
} from "../apps/events-contract/src/sdk.ts";
import type {
  EventsORPCClient,
  Processor,
  ProcessorLogger,
} from "../apps/events-contract/src/sdk.ts";
import { createWorkshopEventsClient } from "./events-client.ts";

export {
  eventsContract,
  getDiscoveredStreamPath,
  matchesStreamPattern,
  normalizeStreamPattern,
  type EventsORPCClient,
  PushSubscriptionProcessorRuntime,
  PullSubscriptionProcessorRuntime,
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

type BasePullSubscriptionPatternProcessorRuntimeArgs = ConstructorParameters<
  typeof BasePullSubscriptionPatternProcessorRuntime
>[0];

export class PullSubscriptionPatternProcessorRuntime<
  State,
> extends BasePullSubscriptionPatternProcessorRuntime<State> {
  constructor({
    eventsClient = createEventsClient() as BasePullSubscriptionPatternProcessorRuntimeArgs["eventsClient"],
    logger = console,
    pathPrefix,
    processor,
  }: {
    eventsClient?: BasePullSubscriptionPatternProcessorRuntimeArgs["eventsClient"];
    logger?: ProcessorLogger;
    pathPrefix: string;
    processor: Processor<State>;
  }) {
    super({
      eventsClient,
      logger,
      pathPrefix,
      processor,
    });
  }
}
