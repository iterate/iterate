import { QueryClient } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { eventsContract } from "@iterate-com/events-contract";
import { iterateProjectHeader, resolveProjectSlug, withProjectHeader } from "~/lib/project-slug.ts";
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
    new OpenAPILink(eventsContract, {
      url: `${window.location.origin}/api`,
      fetch: (request, init) => {
        const requestInit = init as RequestInit | undefined;
        const headers = new Headers(
          request instanceof Request ? request.headers : requestInit?.headers,
        );
        headers.set(iterateProjectHeader, resolveProjectSlug({ url: window.location.href }));
        return fetch(request, { ...requestInit, headers });
      },
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

          if (!context.rawRequest) {
            return context;
          }

          return {
            ...context,
            rawRequest: withProjectHeader(
              context.rawRequest,
              resolveProjectSlug({
                url: context.rawRequest.url,
                headerValue: context.rawRequest.headers.get(iterateProjectHeader),
              }),
            ),
          };
        },
      }),
  )
  .client((): OrpcClient => {
    cachedOpenApiClient ??= createBrowserOpenApiClient();
    return cachedOpenApiClient;
  });

export const orpcClient = makeOrpcClient();
export const orpc = createTanstackQueryUtils(orpcClient);
