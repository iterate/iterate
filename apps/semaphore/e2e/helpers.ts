import { createCloudflareWorkerVersionOverrideFetch } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { z } from "zod";
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
 * config's AUTH_FORGE_ES256_PRIVATE_JWK — semaphore verifies both against the same
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

const DeploymentHealth = z.strictObject({
  ok: z.literal(true),
  workerVersion: z.string(),
  coordinatorVersion: z.string(),
});

export async function waitForHealth(args: {
  baseURL: string;
  timeoutMs: number;
  networkFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}) {
  const startedAt = args.now();

  while (args.now() - startedAt < args.timeoutMs) {
    try {
      const response = await args.networkFetch(new URL("/health", args.baseURL));
      const health = DeploymentHealth.safeParse(await response.json());
      if (
        response.ok &&
        health.success &&
        health.data.workerVersion === health.data.coordinatorVersion &&
        response.headers.get("x-iterate-worker-version") === health.data.workerVersion
      ) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await args.sleep(500);
  }

  throw new Error(`Timed out waiting for health at ${args.baseURL}`);
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
