import {
  CloudflareTunnelData,
  cloudflareTunnelType,
  createSemaphoreClient,
} from "@iterate-com/semaphore-contract";
import type { CloudflareTunnelData as CloudflareTunnelDataShape } from "@iterate-com/semaphore-contract";

const defaultLeaseMs = 10 * 60 * 1000;
const defaultWaitMs = 60_000;

export interface UseCloudflareTunnelFromSemaphoreOptions {
  semaphoreWorkerApiKey: string;
  semaphoreWorkerUrl: string;
  leaseMs?: number;
  waitMs?: number;
}

export type CloudflareTunnelHandle = AsyncDisposable &
  CloudflareTunnelDataShape & {
    readonly slug: string;
    readonly leaseId: string;
    readonly expiresAt: number;
    release(): Promise<void>;
  };

export async function useCloudflareTunnelFromSemaphore(
  options: UseCloudflareTunnelFromSemaphoreOptions,
): Promise<CloudflareTunnelHandle> {
  const client = createSemaphoreClient({
    apiKey: options.semaphoreWorkerApiKey,
    baseURL: options.semaphoreWorkerUrl,
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
      provider: tunnel.provider,
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
