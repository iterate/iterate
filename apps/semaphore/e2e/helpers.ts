type SemaphoreAppFixture = {
  apiKey: string;
  baseURL: string;
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
  apiFetch(pathname: string, init?: RequestInit): Promise<Response>;
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

export function requireSemaphoreApiToken() {
  const overrideValue = process.env.APP_CONFIG_SHARED_API_SECRET?.trim();
  if (overrideValue) {
    return overrideValue;
  }

  const baseConfigValue = process.env.APP_CONFIG?.trim();
  if (baseConfigValue) {
    const parsed = JSON.parse(baseConfigValue) as { sharedApiSecret?: unknown };
    if (typeof parsed.sharedApiSecret === "string" && parsed.sharedApiSecret.trim().length > 0) {
      return parsed.sharedApiSecret.trim();
    }
  }

  const value = process.env.SEMAPHORE_API_TOKEN?.trim();
  if (!value) {
    throw new Error(
      "SEMAPHORE_API_TOKEN or APP_CONFIG_SHARED_API_SECRET is required for semaphore network e2e tests. Run via `doppler run` or export the token first.",
    );
  }

  return value;
}

export function createSemaphoreAppFixture(args: {
  apiKey: string;
  baseURL: string;
}): SemaphoreAppFixture {
  const baseURL = args.baseURL.replace(/\/+$/, "");
  const apiFetch: SemaphoreAppFixture["apiFetch"] = async (pathname, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${args.apiKey}`);
    return fetch(new URL(pathname, baseURL), {
      ...init,
      headers,
    });
  };

  return {
    apiKey: args.apiKey,
    baseURL,
    fetch: (pathname, init) => fetch(new URL(pathname, baseURL), init),
    apiFetch,
  };
}

export async function waitForHealth(baseURL: string, timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL("/health", baseURL));
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
