import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import {
  createEventsClient as createBaseEventsClient,
  eventsContract,
} from "../apps/events-contract/src/sdk.ts";
import type { EventsORPCClient } from "../apps/events-contract/src/sdk.ts";

const iterateProjectHeader = "x-iterate-project";

export function createWorkshopEventsClient({
  baseUrl,
  closeConnection,
  projectSlug,
}: {
  baseUrl: string;
  closeConnection?: boolean;
  projectSlug?: string;
}): EventsORPCClient {
  if (projectSlug == null) {
    return createBaseEventsClient(baseUrl);
  }

  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
      fetch: (request: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
        if (closeConnection) {
          headers.set("connection", "close");
        }
        headers.set(iterateProjectHeader, projectSlug);
        return fetch(request, { ...init, headers });
      },
    }),
  ) as EventsORPCClient;
}
