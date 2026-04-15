import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import {
  createEventsClient as createBaseEventsClient,
  eventsContract,
} from "../apps/events-contract/src/sdk.ts";
import { ProjectSlug } from "../apps/events-contract/src/types.ts";
import { getProjectUrl } from "../apps/events/src/lib/project-slug.ts";
import type { EventsORPCClient } from "../apps/events-contract/src/sdk.ts";

export function createWorkshopEventsClient({
  baseUrl,
  closeConnection,
  projectSlug,
}: {
  baseUrl: string;
  closeConnection?: boolean;
  projectSlug?: string;
}): EventsORPCClient {
  if (projectSlug == null && !closeConnection) {
    return createBaseEventsClient(baseUrl);
  }

  const projectBaseUrl =
    projectSlug == null
      ? baseUrl
      : getProjectUrl({
          currentUrl: baseUrl,
          projectSlug: ProjectSlug.parse(projectSlug),
        }).toString();

  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", projectBaseUrl).toString(),
      fetch: (request: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
        if (closeConnection) {
          headers.set("connection", "close");
        }
        return fetch(request, { ...init, headers });
      },
    }),
  ) as EventsORPCClient;
}
