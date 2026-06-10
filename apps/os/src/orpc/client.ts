import { QueryClient } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { osContract } from "@iterate-com/os-contract";
import type { appRouter } from "~/orpc/root.ts";
import { requireRequestContext } from "~/request-context.ts";

export const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        gcTime: 5 * 60 * 1000,
        retry: 1,
        refetchOnWindowFocus: false,
        refetchOnMount: true,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: 0,
      },
    },
  });

type OrpcClient = RouterClient<typeof appRouter>;

/**
 * Keep the TanStack Start route graph small by keeping the client typed from
 * the server router, but using the contract-only OpenAPI transport at runtime.
 * A direct in-process router client here pulls every oRPC handler and domain
 * dependency into the SSR route bundle.
 *
 * Docs:
 * - https://orpc.dev/docs/adapters/tanstack-start
 * - https://orpc.dev/docs/best-practices/optimize-ssr
 *
 * The request context comes from `handler.fetch(request, { context })` in the
 * runtime entrypoints and is exposed to SSR via TanStack Start's request storage.
 */

function createOpenApiClient(input: { headers?: Headers; url: string }): OrpcClient {
  return createORPCClient(
    new OpenAPILink(osContract, {
      headers: input.headers,
      url: input.url,
    }),
  );
}

function createBrowserOpenApiClient(): OrpcClient {
  return createOpenApiClient({ url: `${window.location.origin}/api` });
}

let cachedBrowserOpenApiClient: OrpcClient | undefined;

const makeOrpcClient = createIsomorphicFn()
  .server((): OrpcClient => {
    const context = requireRequestContext();
    const requestUrl = context.rawRequest ? new URL(context.rawRequest.url) : undefined;
    const baseUrl = context.config.baseUrl ?? requestUrl?.origin;
    if (!baseUrl) throw new Error("Cannot create server oRPC client without a base URL.");

    return createOpenApiClient({
      headers: getForwardedOpenApiHeaders(context.rawRequest),
      url: `${baseUrl.replace(/\/+$/, "")}/api`,
    });
  })
  .client((): OrpcClient => {
    cachedBrowserOpenApiClient ??= createBrowserOpenApiClient();
    return cachedBrowserOpenApiClient;
  });

export const orpcClient = makeOrpcClient();
export const orpc = createTanstackQueryUtils(orpcClient);

/**
 * The log stream demo needs explicit transport switching between OpenAPI fetch
 * and the websocket endpoint, so we keep the browser-only transport helpers here.
 */
export function createBrowserWebSocketClient(options?: { organizationSlug?: string }) {
  const url = new URL("/api/orpc-ws", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (options?.organizationSlug) {
    url.searchParams.set("organizationSlug", options.organizationSlug);
  }
  const websocket = new WebSocket(url.toString());
  const client = createORPCClient(new WebSocketRPCLink({ websocket })) as OrpcClient;

  return {
    client,
    close: () => websocket.close(),
  };
}

export { createBrowserOpenApiClient };

function getForwardedOpenApiHeaders(request: Request | undefined) {
  const headers = new Headers();
  const cookie = request?.headers.get("cookie");
  const authorization = request?.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);
  return headers;
}
