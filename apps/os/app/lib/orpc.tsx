import { QueryClient } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getContext } from "hono/context-storage";
import { appRouter, type AppRouter } from "../../backend/orpc/root.ts";
import { createContext } from "../../backend/orpc/context.ts";
import type { Variables } from "../../backend/types.ts";
import type { CloudflareEnv } from "../../env.ts";

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

/**
 * Isomorphic oRPC client:
 * - Server: uses `createRouterClient` for direct in-process calls (no HTTP overhead during SSR)
 * - Client: uses `createORPCClient` + `RPCLink` for browser→server HTTP calls
 */
export type OrpcClient = RouterClient<AppRouter>;
export const makeOrpcClient = createIsomorphicFn()
  .server(
    (): OrpcClient =>
      createRouterClient(appRouter, {
        context: async () => {
          const c = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();
          return createContext(c);
        },
      }),
  )
  .client(
    (): OrpcClient =>
      createORPCClient(
        new RPCLink({
          url: `${window.location.origin}/api/orpc`,
        }),
      ),
  );

export const orpcClient = makeOrpcClient();
export const orpc = createTanstackQueryUtils(orpcClient);
