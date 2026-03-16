import {
  CloudflareTunnelData,
  cloudflareTunnelType,
  createSemaphoreClient,
} from "@iterate-com/semaphore-contract";
import type { CloudflareTunnelData as CloudflareTunnelDataShape } from "@iterate-com/semaphore-contract";

const defaultLeaseMs = 10 * 60 * 1000;
const defaultWaitMs = 60_000;

export interface UseCloudflareTunnelFromSemaphoreOptions {
  apiToken: string;
  baseUrl: string;
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
  console.log("[useCloudflareTunnelFromSemaphore] creating semaphore client", {
    baseUrl: options.baseUrl,
    leaseMs: options.leaseMs ?? defaultLeaseMs,
    waitMs: options.waitMs ?? defaultWaitMs,
  });
  const client = createSemaphoreClient({
    apiKey: options.apiToken,
    baseURL: options.baseUrl,
  });
  console.log("[useCloudflareTunnelFromSemaphore] acquiring tunnel lease");
  const lease = await client.resources.acquire({
    type: cloudflareTunnelType,
    leaseMs: options.leaseMs ?? defaultLeaseMs,
    waitMs: options.waitMs ?? defaultWaitMs,
  });
  console.log("[useCloudflareTunnelFromSemaphore] acquired tunnel lease", {
    slug: lease.slug,
    leaseId: lease.leaseId,
    expiresAt: lease.expiresAt,
  });

  let released = false;

  const release = async () => {
    if (released) {
      console.log(
        "[useCloudflareTunnelFromSemaphore] release skipped because lease is already released",
        {
          slug: lease.slug,
          leaseId: lease.leaseId,
        },
      );
      return;
    }
    console.log("[useCloudflareTunnelFromSemaphore] releasing tunnel lease", {
      slug: lease.slug,
      leaseId: lease.leaseId,
    });
    released = true;
    await client.resources.release({
      type: cloudflareTunnelType,
      slug: lease.slug,
      leaseId: lease.leaseId,
    });
    console.log("[useCloudflareTunnelFromSemaphore] released tunnel lease", {
      slug: lease.slug,
      leaseId: lease.leaseId,
    });
  };

  try {
    console.log("[useCloudflareTunnelFromSemaphore] parsing tunnel lease data", {
      slug: lease.slug,
      leaseId: lease.leaseId,
    });
    const tunnel = CloudflareTunnelData.parse(lease.data);
    console.log("[useCloudflareTunnelFromSemaphore] parsed tunnel lease data", {
      slug: lease.slug,
      leaseId: lease.leaseId,
      provider: tunnel.provider,
      publicHostname: tunnel.publicHostname,
      tunnelId: tunnel.tunnelId,
      tunnelName: tunnel.tunnelName,
      service: tunnel.service,
      createdAt: tunnel.createdAt,
    });

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
        console.log("[useCloudflareTunnelFromSemaphore] async dispose requested", {
          slug: lease.slug,
          leaseId: lease.leaseId,
        });
        await release();
      },
    };
  } catch (error) {
    console.log(
      "[useCloudflareTunnelFromSemaphore] failed after lease acquire, attempting cleanup",
      {
        slug: lease.slug,
        leaseId: lease.leaseId,
        error,
      },
    );
    await release().catch(() => {});
    throw error;
  }
}
