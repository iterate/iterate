import { QueryClient } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { semaphoreContract } from "@iterate-com/semaphore-contract";
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

function createBrowserOpenApiClient(): OrpcClient {
  return createORPCClient(
    new OpenAPILink(semaphoreContract, {
      url: `${window.location.origin}/api`,
    }),
  );
}

let cachedOpenApiClient: OrpcClient | undefined;

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
    cachedOpenApiClient ??= createBrowserOpenApiClient();
    return cachedOpenApiClient;
  });

export const orpcClient = makeOrpcClient();
export const orpc = createTanstackQueryUtils(orpcClient);
