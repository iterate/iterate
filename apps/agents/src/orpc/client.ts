import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { QueryClient } from "@tanstack/react-query";
import { getGlobalStartContext } from "@tanstack/react-start";
import { agentsContract } from "@iterate-com/agents-contract";

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

type OrpcClient = ContractRouterClient<typeof agentsContract>;

let configuredBaseUrl: string | undefined;
let cachedApiUrl: string | undefined;
let cachedClient: OrpcClient | undefined;

/**
 * Keep this file deliberately small. Agents only uses the browser OpenAPI client today,
 * while SSR/root config is loaded via `createServerFn` in `routes/__root.tsx`.
 *
 * Docs:
 * - https://orpc.dev/docs/adapters/tanstack-start
 * - https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
 */
function createOpenApiClient(baseUrl: string | undefined) {
  return createORPCClient(
    new OpenAPILink(agentsContract, {
      url: resolveApiUrl(baseUrl),
    }),
  ) as OrpcClient;
}

export function configureOrpcClient(options: { baseUrl?: string } = {}) {
  configuredBaseUrl = options.baseUrl;

  if (typeof window === "undefined") {
    return;
  }

  const nextApiUrl = resolveApiUrl(configuredBaseUrl);
  if (cachedApiUrl === nextApiUrl) {
    return cachedClient;
  }

  cachedApiUrl = nextApiUrl;
  cachedClient = createOpenApiClient(configuredBaseUrl);
  return cachedClient;
}

export function getOrpcClient() {
  if (typeof window === "undefined") {
    return createOpenApiClient(configuredBaseUrl);
  }

  cachedClient ??= createOpenApiClient(configuredBaseUrl);
  cachedApiUrl ??= resolveApiUrl(configuredBaseUrl);
  return cachedClient;
}

function resolveApiUrl(baseUrl: string | undefined) {
  return new URL(normalizeApiBaseUrl(baseUrl), getCurrentUrl()).toString();
}

function getCurrentUrl() {
  if (typeof window !== "undefined") {
    return window.location.href;
  }

  return getGlobalStartContext()?.rawRequest?.url ?? "http://localhost/";
}

function normalizeApiBaseUrl(baseUrl: string | undefined) {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "/api";
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
