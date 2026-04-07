import type { ContractRouterClient } from "@orpc/contract";
import { QueryClient } from "@tanstack/react-query";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { getGlobalStartContext } from "@tanstack/react-start";
import { eventsContract } from "@iterate-com/events-contract";
import { iterateProjectHeader, resolveProjectSlug } from "~/lib/project-slug.ts";

const DEFAULT_API_BASE_URL = "/api";

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

export type OrpcClient = ContractRouterClient<typeof eventsContract>;

type OrpcClientOptions = {
  baseUrl?: string;
};

type BrowserOrpcState = {
  apiUrl: string;
  client: OrpcClient;
  queryUtils: OrpcQueryUtils;
};

let configuredBaseUrl: string | undefined;
let browserOrpcState: BrowserOrpcState | undefined;

function createOrpcQueryUtils(client: OrpcClient) {
  return createTanstackQueryUtils(client);
}

type OrpcQueryUtils = ReturnType<typeof createOrpcQueryUtils>;

function getCurrentUrl() {
  if (typeof window !== "undefined") {
    return window.location.href;
  }

  const requestUrl = getGlobalStartContext()?.rawRequest?.url;
  if (requestUrl) {
    return requestUrl;
  }

  return "http://localhost/";
}

function getCurrentHeaderValue(name: string) {
  if (typeof window !== "undefined") {
    return undefined;
  }

  return getGlobalStartContext()?.rawRequest?.headers.get(name) ?? undefined;
}

function normalizeApiBaseUrl(baseUrl: string | undefined) {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_API_BASE_URL;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveApiUrl(baseUrl: string | undefined) {
  return new URL(normalizeApiBaseUrl(baseUrl), getCurrentUrl()).toString();
}

function createFetchWithProjectHeader() {
  return (request: Request | URL | string, init?: RequestInit) => {
    const requestInit = init as RequestInit | undefined;
    const headers = new Headers(
      request instanceof Request ? request.headers : requestInit?.headers,
    );
    headers.set(
      iterateProjectHeader,
      resolveProjectSlug({
        url: getCurrentUrl(),
        headerValue: getCurrentHeaderValue(iterateProjectHeader),
      }),
    );

    return fetch(request, { ...requestInit, headers });
  };
}

export function makeOrpcClient(options: OrpcClientOptions = {}): OrpcClient {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: resolveApiUrl(options.baseUrl ?? configuredBaseUrl),
      fetch: createFetchWithProjectHeader(),
    }),
  ) as OrpcClient;
}

function createBrowserOrpcState(options: OrpcClientOptions = {}) {
  const client = makeOrpcClient(options);
  const queryUtils = createOrpcQueryUtils(client);

  return {
    apiUrl: resolveApiUrl(options.baseUrl ?? configuredBaseUrl),
    client,
    queryUtils,
  };
}

export function configureOrpcClient(options: OrpcClientOptions = {}) {
  configuredBaseUrl = options.baseUrl;

  if (typeof window === "undefined") {
    return makeOrpcClient(options);
  }

  const nextApiUrl = resolveApiUrl(options.baseUrl);
  if (browserOrpcState?.apiUrl === nextApiUrl) {
    return browserOrpcState.client;
  }

  browserOrpcState = createBrowserOrpcState(options);
  return browserOrpcState.client;
}

function getBrowserOrpcState() {
  browserOrpcState ??= createBrowserOrpcState({ baseUrl: configuredBaseUrl });
  return browserOrpcState;
}

export function getOrpcClient() {
  if (typeof window === "undefined") {
    return makeOrpcClient({ baseUrl: configuredBaseUrl });
  }

  return getBrowserOrpcState().client;
}

export function getOrpc() {
  if (typeof window === "undefined") {
    return createOrpcQueryUtils(makeOrpcClient({ baseUrl: configuredBaseUrl }));
  }

  return getBrowserOrpcState().queryUtils;
}
