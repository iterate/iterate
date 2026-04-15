import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "@iterate-com/events-contract/sdk";

const iterateProjectHeader = "x-iterate-project";

export type EventsOrpcClient = ContractRouterClient<typeof eventsContract>;

export function createEventsOrpcClient(options: {
  baseUrl: string;
  projectSlug: string;
}): EventsOrpcClient {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", options.baseUrl).toString(),
      fetch: (request, init) => {
        const requestInit = init as RequestInit | undefined;
        const headers = new Headers(
          request instanceof Request ? request.headers : requestInit?.headers,
        );
        headers.set(iterateProjectHeader, options.projectSlug);
        return fetch(request, {
          ...requestInit,
          headers,
        });
      },
    }),
  ) as EventsOrpcClient;
}
