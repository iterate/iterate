import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { ProjectSlug, eventsContract } from "@iterate-com/events-contract";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";

export type EventsOrpcClient = ContractRouterClient<typeof eventsContract>;

export function createEventsOrpcClient(options: {
  baseUrl: string;
  projectSlug: string;
}): EventsOrpcClient {
  const projectOrigin = getProjectUrl({
    currentUrl: options.baseUrl,
    projectSlug: ProjectSlug.parse(options.projectSlug),
  })
    .toString()
    .replace(/\/+$/, "");

  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", projectOrigin).toString(),
      // Bare `fetch` loses the correct `this` when OpenAPILink invokes it (Workers illegal invocation).
      fetch: (input, init) => globalThis.fetch(input, init),
    }),
  ) as EventsOrpcClient;
}
