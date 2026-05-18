import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "@iterate-com/events-contract";
import { StreamNamespace } from "@iterate-com/shared/streams/types";
import { getProjectUrl, workerReachableLocalUrl } from "~/lib/events-urls.ts";

export type EventsOrpcClient = ContractRouterClient<typeof eventsContract>;

export function createEventsOrpcClient(options: {
  baseUrl: string;
  projectId: string;
}): EventsOrpcClient {
  const projectOrigin = getProjectUrl({
    currentUrl: options.baseUrl,
    projectId: StreamNamespace.parse(options.projectId),
  })
    .toString()
    .replace(/\/+$/, "");
  const fetchOrigin =
    typeof window === "undefined"
      ? workerReachableLocalUrl(projectOrigin).replace(/\/+$/, "")
      : projectOrigin;

  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", fetchOrigin).toString(),
      // Bare `fetch` loses the correct `this` when OpenAPILink invokes it (Workers illegal invocation).
      fetch: (input, init) => globalThis.fetch(input, init),
    }),
  ) as EventsOrpcClient;
}
