import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "@iterate-com/events-contract";

export function createEventsClient(baseUrl: string) {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
    }),
  ) as ContractRouterClient<typeof eventsContract>;
}
