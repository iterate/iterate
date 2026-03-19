import { QueryClient } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { DurableIteratorLinkPlugin } from "@orpc/experimental-durable-iterator/client";
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
          plugins: [
            new DurableIteratorLinkPlugin({
              url: (tokenPayload) => {
                const protocol = window.location.protocol === "https:" ? "wss" : "ws";
                const endpoint = tokenPayload.tags?.includes("deployment-durable-object")
                  ? "deployment"
                  : "project-deployments";

                // oRPC's Durable Iterator tokens already carry tags. Using those tags to pick
                // the upgrade endpoint keeps the transport contract explicit and avoids baking
                // namespace routing into the channel name string itself.
                return `${protocol}://${window.location.host}/api/orpc-iterator/${endpoint}`;
              },
              refreshTokenBeforeExpireInSeconds: () => 300,
            }),
          ],
        }),
      ),
  );

export const orpcClient = makeOrpcClient();
export const orpc = createTanstackQueryUtils(orpcClient);
