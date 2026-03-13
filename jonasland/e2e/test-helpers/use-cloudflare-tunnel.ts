import {
  CloudflareTunnelData,
  cloudflareTunnelType,
  createSemaphoreClient,
} from "@iterate-com/semaphore-contract";

const defaultLeaseMs = 10 * 60 * 1000;
const defaultWaitMs = 60_000;

export interface UseCloudflareTunnelOptions {
  semaphoreApiKey: string;
  semaphoreBaseUrl: string;
  leaseMs?: number;
  waitMs?: number;
}

export interface CloudflareTunnelHandle extends AsyncDisposable {
  readonly slug: string;
  readonly leaseId: string;
  readonly expiresAt: number;
  readonly publicHostname: string;
  readonly tunnelId: string;
  readonly tunnelName: string;
  readonly tunnelToken: string;
  readonly service: string;
  readonly createdAt: string;
  release(): Promise<void>;
}

export async function useCloudflareTunnel(
  options: UseCloudflareTunnelOptions,
): Promise<CloudflareTunnelHandle> {
  const client = createSemaphoreClient({
    apiKey: options.semaphoreApiKey,
    baseURL: options.semaphoreBaseUrl,
  });
  const lease = await client.resources.acquire({
    type: cloudflareTunnelType,
    leaseMs: options.leaseMs ?? defaultLeaseMs,
    waitMs: options.waitMs ?? defaultWaitMs,
  });

  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    await client.resources.release({
      type: cloudflareTunnelType,
      slug: lease.slug,
      leaseId: lease.leaseId,
    });
  };

  try {
    const tunnel = CloudflareTunnelData.parse(lease.data);

    return {
      slug: lease.slug,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
      publicHostname: tunnel.publicHostname,
      tunnelId: tunnel.tunnelId,
      tunnelName: tunnel.tunnelName,
      tunnelToken: tunnel.tunnelToken,
      service: tunnel.service,
      createdAt: tunnel.createdAt,
      release,
      async [Symbol.asyncDispose]() {
        if (process.env.E2E_NO_DISPOSE) return;
        await release();
      },
    };
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}
