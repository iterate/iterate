const DEFAULT_SEMAPHORE_BASE_URL = "https://semaphore.iterate.com";
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

export interface UseSemaphoreLeaseOptions<TData> {
  type: string;
  parseData: (data: unknown) => TData;
  apiToken?: string;
  baseUrl?: string;
  leaseMs?: number;
  waitMs?: number;
}

export interface SemaphoreLeaseHandle<TData> extends AsyncDisposable {
  slug: string;
  leaseId: string;
  expiresAt: number;
  data: TData;
  release(): Promise<void>;
}

type SemaphoreLeaseResponse = {
  slug: string;
  leaseId: string;
  expiresAt: number;
  data: unknown;
};

async function semaphoreRequest<TResponse>(options: {
  apiToken: string;
  baseUrl: string;
  body?: unknown;
  method: string;
  path: string;
}): Promise<TResponse> {
  const response = await fetch(new URL(options.path, options.baseUrl), {
    method: options.method,
    headers: {
      authorization: `Bearer ${options.apiToken}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    throw new Error(
      `Semaphore ${options.method} ${options.path} failed with ${response.status}: ${await response.text()}`,
    );
  }

  return (await response.json()) as TResponse;
}

/**
 * Acquire a Semaphore resource lease and release it on dispose.
 */
export async function useSemaphoreLease<TData>(
  options: UseSemaphoreLeaseOptions<TData>,
): Promise<SemaphoreLeaseHandle<TData>> {
  const apiToken = options.apiToken ?? process.env.SEMAPHORE_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error("SEMAPHORE_API_TOKEN is required to acquire a Semaphore lease");
  }

  const baseUrl = (options.baseUrl ?? process.env.SEMAPHORE_BASE_URL ?? DEFAULT_SEMAPHORE_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const lease = await semaphoreRequest<SemaphoreLeaseResponse>({
    apiToken,
    baseUrl,
    method: "POST",
    path: "/api/resources/acquire",
    body: {
      type: options.type,
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
    },
  });

  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    await semaphoreRequest<{ released: boolean }>({
      apiToken,
      baseUrl,
      method: "POST",
      path: "/api/resources/release",
      body: {
        type: options.type,
        slug: lease.slug,
        leaseId: lease.leaseId,
      },
    });
  };

  return {
    slug: lease.slug,
    leaseId: lease.leaseId,
    expiresAt: lease.expiresAt,
    data: options.parseData(lease.data),
    release,
    async [Symbol.asyncDispose]() {
      await release();
    },
  };
}
