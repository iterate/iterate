import { QueryClient } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { exampleContract } from "@iterate-com/example-contract";
import { appRouter } from "~/orpc/root.ts";

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
 * Keep the canonical TanStack Start + oRPC SSR shape small:
 * - server: direct in-process router client
 * - browser: OpenAPI client on `/api`
 *
 * Docs:
 * - https://orpc.dev/docs/adapters/tanstack-start
 * - https://orpc.dev/docs/best-practices/optimize-ssr
 *
 * The request context comes from `handler.fetch(request, { context })` in the
 * runtime entrypoints and is exposed to SSR via TanStack Start's request storage.
 */

function createBrowserOpenApiClient(): OrpcClient {
  return createORPCClient(
    new OpenAPILink(exampleContract, {
      url: `${window.location.origin}/api`,
    }),
  );
}

let cachedBrowserOpenApiClient: OrpcClient | undefined;

const makeOrpcClient = createIsomorphicFn()
  .server(
    (): OrpcClient =>
      createRouterClient(appRouter, {
        context: () => {
          const context = getGlobalStartContext();
          if (!context) {
            throw new Error(
              "No tanstack start context found for the request - your entrypoint is wired up wrong",
            );
          }

          return context;
        },
      }),
  )
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
export function createBrowserWebSocketClient() {
  const url = new URL("/api/orpc-ws", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const websocket = new WebSocket(url.toString());
  const client = createORPCClient(new WebSocketRPCLink({ websocket })) as OrpcClient;

  return {
    client,
    close: () => websocket.close(),
  };
}

export { createBrowserOpenApiClient };
