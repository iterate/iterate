import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

import { semaphoreContract } from "./contract.ts";

export type SemaphoreClient = ContractRouterClient<typeof semaphoreContract>;
export type SemaphoreFetch = (
  input: URL | string | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CreateSemaphoreClientOptions =
  | {
      apiKey: string;
      baseURL: string;
      fetch?: SemaphoreFetch;
    }
  | {
      apiKey: string;
      fetch: SemaphoreFetch;
      baseURL?: string;
    };

export const FETCH_ONLY_PLACEHOLDER_URL = "https://semaphore.invalid/api/orpc";

export function resolveSemaphoreOrpcUrl(options: {
  baseURL?: string;
  fetch?: SemaphoreFetch;
}): string {
  if (options.baseURL) {
    return new URL("/api/orpc", options.baseURL).toString();
  }

  if (options.fetch) {
    return FETCH_ONLY_PLACEHOLDER_URL;
  }

  throw new Error("createSemaphoreClient requires either baseURL or fetch");
}

export function createSemaphoreClient(options: CreateSemaphoreClientOptions): SemaphoreClient {
  const url = resolveSemaphoreOrpcUrl(options);

  // RPCLink still expects a URL even when callers provide a custom fetch. Using a placeholder here
  // lets service-binding or loopback fetchers handle dispatch without a public base URL.
  const link = new RPCLink({
    url,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    ...(options.fetch
      ? {
          fetch: (input: URL | string | Request, init?: RequestInit) => options.fetch!(input, init),
        }
      : {}),
  });

  return createORPCClient(link);
}
