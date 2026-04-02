import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import {
  eventsContract,
  type Event,
  type EventInput,
  type Offset,
  type StreamPath,
} from "./contract.ts";

export { eventsContract } from "./contract.ts";
export type { Event, EventInput, EventType, JSONObject, Offset, StreamPath } from "./contract.ts";
export { PullSubscriptionProcessorRuntime } from "./pull-subscription-processor-runtime.ts";
export {
  getDefaultWorkshopPathPrefix,
  isMainModule,
  normalizePathPrefix,
  runWorkshopMain,
} from "./run-script.ts";
export { defineProcessor } from "./stream-process.ts";
export type { StreamProcessor } from "./stream-process.ts";

export type EventsClient = {
  append(input: { path: StreamPath; event: EventInput }): Promise<{
    created: boolean;
    event: Event;
    events: [Event];
  }>;
  stream(
    input: { path: StreamPath; offset?: Offset; live?: boolean },
    options: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Event>>;
};

export function createEventsClient(baseUrl: string): EventsClient {
  const client = createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
    }),
  ) as ContractRouterClient<typeof eventsContract>;

  return {
    async append(input: { path: StreamPath; event: EventInput }) {
      const result = await client.append({
        params: { path: input.path },
        body: input.event,
      });

      return {
        created: true,
        event: result.event,
        events: [result.event],
      };
    },
    async stream(
      input: { path: StreamPath; offset?: Offset; live?: boolean },
      options: { signal?: AbortSignal },
    ) {
      return client.stream(input, options);
    },
  };
}
