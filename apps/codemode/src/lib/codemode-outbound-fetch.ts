import type { CodemodeOpenApiFetch } from "~/lib/openapi-codemode-context.ts";

export function createCodemodeOutboundFetch(outbound: Fetcher): CodemodeOpenApiFetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);

    return outbound.fetch(request);
  };
}
