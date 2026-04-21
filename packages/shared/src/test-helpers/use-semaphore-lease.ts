import { createSemaphoreClient } from "@iterate-com/semaphore-contract";

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
  const client = createSemaphoreClient({
    apiKey: apiToken,
    baseURL: baseUrl,
  });
  const lease = await client.resources.acquire({
    type: options.type,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
  });

  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    await client.resources.release({
      type: options.type,
      slug: lease.slug,
      leaseId: lease.leaseId,
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
