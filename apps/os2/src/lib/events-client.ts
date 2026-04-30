import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "@iterate-com/events-contract";

export type EventsClient = ContractRouterClient<typeof eventsContract>;

/**
 * Creates the small oRPC client OS2 needs for talking to the events app.
 *
 * This intentionally lives in OS2 instead of resurrecting the deleted
 * `@iterate-com/events-contract/sdk` export. The contract package owns schemas
 * and routes; each app should decide the transport shape it wants at its own
 * boundary.
 */
export function createEventsClient(baseUrl: string): EventsClient {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
      // Workers can throw "Illegal invocation" if fetch is passed unbound.
      fetch: (input, init) => globalThis.fetch(input, init),
    }),
  ) as EventsClient;
}
