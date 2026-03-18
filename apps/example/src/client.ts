import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { exampleContract } from "@iterate-com/example-contract";

export type ExampleClient = ContractRouterClient<typeof exampleContract>;

function resolveExampleApiUrl(url?: string) {
  // OpenAPILink wants a concrete URL. In the browser we derive it lazily from
  // window.location, but server-side callers must pass an absolute base URL
  // explicitly instead of relying on "/api".
  //
  // First-party docs:
  // - OpenAPILink setup:
  //   https://orpc.unnoq.com/docs/openapi/client/openapi-link
  // - Lazy URL for environment-aware resolution:
  //   https://orpc.unnoq.com/docs/openapi/client/openapi-link#lazy-url
  if (url) {
    return new URL("/api", url).toString();
  }

  if (typeof window === "undefined") {
    throw new Error("createExampleClient requires an absolute url when used on the server");
  }

  return new URL("/api", window.location.origin).toString();
}

export function createExampleClient(params?: {
  url?: string;
  fetch?: typeof fetch;
}): ExampleClient {
  return createORPCClient(
    new OpenAPILink(exampleContract, {
      url: () => resolveExampleApiUrl(params?.url),
      ...(params?.fetch ? { fetch: params.fetch } : {}),
    }),
  );
}
