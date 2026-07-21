import {
  createCloudflareWorkerVersionOverrideFetch,
  mergeCloudflareWorkerVersionOverrideHeaders,
} from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { createSemaphoreTokenProvider } from "../../../scripts/auth/semaphore-token.ts";

type SemaphoreAppFixture = {
  apiKey: () => Promise<string>;
  baseURL: string;
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
  apiFetch(pathname: string, init?: RequestInit): Promise<Response>;
  networkFetch: typeof fetch;
};

export function requireSemaphoreBaseUrl() {
  const value = process.env.SEMAPHORE_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      "SEMAPHORE_BASE_URL is required for semaphore network e2e tests. Start or deploy the worker outside the test runner, then run the suite with SEMAPHORE_BASE_URL=https://... .",
    );
  }

  return value.replace(/\/+$/, "");
}

/**
 * Bearer-token provider for the suite: SEMAPHORE_API_TOKEN (a pre-minted
 * bearer token), else an admin access token forge-minted from the Doppler
 * config's AUTH_FORGE_PRIVATE_JWK — semaphore verifies both against the same
 * apps/auth relying-party setup as os.
 */
export function semaphoreApiTokenProvider(baseURL: string) {
  return createSemaphoreTokenProvider({
    baseUrl: baseURL,
    email: "semaphore-e2e@iterate.com",
  });
}

export function createSemaphoreAppFixture(args: {
  apiKey: () => Promise<string>;
  baseURL: string;
}): SemaphoreAppFixture {
  const baseURL = args.baseURL.replace(/\/+$/, "");
  const networkFetch = createCloudflareWorkerVersionOverrideFetch(
    globalThis.fetch.bind(globalThis),
    process.env,
  );
  const apiFetch: SemaphoreAppFixture["apiFetch"] = async (pathname, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${await args.apiKey()}`);
    return networkFetch(new URL(pathname, baseURL), {
      ...init,
      headers,
    });
  };

  return {
    apiKey: args.apiKey,
    baseURL,
    fetch: (pathname, init) => networkFetch(new URL(pathname, baseURL), init),
    apiFetch,
    networkFetch,
  };
}

export async function waitForHealth(baseURL: string, timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL("/health", baseURL), {
        headers: mergeCloudflareWorkerVersionOverrideHeaders(undefined, process.env),
      });
      if (response.ok && (await response.text()) === "OK") {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for health at ${baseURL}`);
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
