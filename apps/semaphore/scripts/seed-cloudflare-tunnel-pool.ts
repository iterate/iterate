import { setTimeout as sleep } from "node:timers/promises";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { z } from "zod";
import {
  CloudflareTunnelData,
  cloudflareTunnelType,
  createSemaphoreClient,
} from "@iterate-com/semaphore-contract";
import { makeFunnySlug } from "../../../packages/shared/src/slug-maker.ts";
import { AppConfig } from "../src/app.ts";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_SEMAPHORE_BASE_URL = "https://semaphore.iterate.com";
const DEFAULT_TUNNEL_COUNT = 20;
const DEFAULT_TUNNEL_SERVICE = "http://localhost:3000";
const DEFAULT_ZONE_NAME = "iterate.com";
const DEFAULT_BASE_DOMAIN = "tunnel.iterate.com";
const CERTIFICATE_POLL_INTERVAL_MS = 10_000;
const CERTIFICATE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const CLOUDFLARE_REQUEST_TIMEOUT_MS = 20_000;
const CLOUDFLARE_MAX_RETRIES = 5;
const CLOUDFLARE_RETRY_BASE_DELAY_MS = 1_000;
const MAX_SLUG_ATTEMPTS = 1_000;

type CloudflareEnvelope<T> = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
};

type TunnelRecord = {
  id: string;
  name: string;
};

type DnsRecord = {
  id: string;
  name: string;
  content: string;
};

type CertificatePack = {
  id: string;
  status: string;
  hosts: string[];
};

export const SeedTunnelPoolInput = z
  .object({
    count: z.coerce.number().int().positive().optional(),
    service: z.string().trim().url().optional(),
    type: z.string().trim().min(1).optional(),
    zoneName: z.string().trim().min(1).optional(),
    baseDomain: z.string().trim().min(1).optional(),
    semaphoreBaseUrl: z.string().trim().url().optional(),
  })
  .default({});

export type SeedTunnelPoolInput = z.infer<typeof SeedTunnelPoolInput>;

function resolveSeedTunnelPoolInput(input: SeedTunnelPoolInput) {
  return {
    count: input.count ?? DEFAULT_TUNNEL_COUNT,
    service: (input.service ?? DEFAULT_TUNNEL_SERVICE).trim(),
    type: (input.type ?? cloudflareTunnelType).trim().toLowerCase(),
    zoneName: (input.zoneName ?? DEFAULT_ZONE_NAME).trim().toLowerCase(),
    baseDomain: (input.baseDomain ?? DEFAULT_BASE_DOMAIN).trim().toLowerCase(),
    semaphoreBaseUrl: (
      input.semaphoreBaseUrl ??
      process.env.SEMAPHORE_BASE_URL ??
      DEFAULT_SEMAPHORE_BASE_URL
    )
      .trim()
      .replace(/\/+$/, ""),
  };
}

type RollbackState = {
  dnsRecordId: string | null;
  tunnelId: string | null;
};

type SeedSummary = {
  existingCount: number;
  createdCount: number;
  alreadyPresentCount: number;
  createdHostnames: string[];
};

class CloudflareRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CloudflareRequestError";
    this.retryable = retryable;
  }
}

export function countMissingResources(existingCount: number, desiredCount: number): number {
  return Math.max(desiredCount - existingCount, 0);
}

export function buildIngressConfig(params: { publicHostname: string; service: string }) {
  return {
    config: {
      ingress: [
        {
          hostname: params.publicHostname,
          service: params.service,
        },
        {
          service: "http_status:404",
        },
      ],
      "warp-routing": {
        enabled: false,
      },
    },
  };
}

export function buildDnsRecordBody(params: {
  publicHostname: string;
  tunnelId: string;
  comment: string;
}) {
  return {
    type: "CNAME",
    name: params.publicHostname,
    content: `${params.tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: params.comment,
  };
}

export function selectReusableCertificatePack(
  packs: CertificatePack[],
  wildcardHost: string,
): CertificatePack | null {
  return (
    packs.find(
      (pack) =>
        pack.hosts.includes(wildcardHost) &&
        ["active", "pending_validation", "initializing", "pending_issuance"].includes(pack.status),
    ) ?? null
  );
}

export function pickUnusedSlug(existingSlugs: Set<string>, makeSlug = makeFunnySlug): string {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = makeSlug();
    if (!existingSlugs.has(slug)) {
      existingSlugs.add(slug);
      return slug;
    }
  }

  throw new Error(`Could not generate a unique slug after ${MAX_SLUG_ATTEMPTS} attempts`);
}

class CloudflareClient {
  private readonly apiToken: string;
  private readonly accountId: string;
  private readonly zoneName: string;

  constructor(apiToken: string, accountId: string, zoneName: string) {
    this.apiToken = apiToken;
    this.accountId = accountId;
    this.zoneName = zoneName;
  }

  private lastEnvelope: CloudflareEnvelope<unknown> | null = null;

  async resolveZoneId(): Promise<string> {
    const zones = await this.request<Array<{ id: string }>>(
      `/zones?name=${encodeURIComponent(this.zoneName)}&status=active&per_page=1`,
    );
    const zoneId = zones[0]?.id;
    if (!zoneId) {
      throw new Error(`Could not resolve Cloudflare zone ID for ${this.zoneName}`);
    }
    return zoneId;
  }

  async listCertificatePacks(zoneId: string): Promise<CertificatePack[]> {
    const packs: CertificatePack[] = [];
    let page = 1;

    while (true) {
      const result = await this.request<CertificatePack[]>(
        `/zones/${zoneId}/ssl/certificate_packs?page=${page}&per_page=50`,
      );
      packs.push(...result);

      const totalPages = this.lastEnvelope?.result_info?.total_pages ?? page;
      if (page >= totalPages) {
        return packs;
      }
      page += 1;
    }
  }

  async ensureCertificate(zoneId: string, baseDomain: string): Promise<CertificatePack> {
    const wildcardHost = `*.${baseDomain}`;
    console.log(`Ensuring wildcard certificate for ${wildcardHost}`);
    const existing = selectReusableCertificatePack(
      await this.listCertificatePacks(zoneId),
      wildcardHost,
    );

    if (existing) {
      return this.waitForCertificate(zoneId, existing.id, wildcardHost);
    }

    const created = await this.request<CertificatePack>(
      `/zones/${zoneId}/ssl/certificate_packs/order`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "advanced",
          hosts: [baseDomain, wildcardHost],
          validation_method: "txt",
          validity_days: 90,
          certificate_authority: "lets_encrypt",
        }),
      },
    );

    return this.waitForCertificate(zoneId, created.id, wildcardHost);
  }

  async getCertificatePack(zoneId: string, certificatePackId: string): Promise<CertificatePack> {
    return this.request<CertificatePack>(
      `/zones/${zoneId}/ssl/certificate_packs/${certificatePackId}`,
    );
  }

  async waitForCertificate(
    zoneId: string,
    certificatePackId: string,
    wildcardHost: string,
  ): Promise<CertificatePack> {
    const deadline = Date.now() + CERTIFICATE_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const pack = await this.getCertificatePack(zoneId, certificatePackId);
      if (pack.status === "active") {
        return pack;
      }
      if (["deleted", "validation_timed_out"].includes(pack.status)) {
        throw new Error(
          `Certificate pack ${certificatePackId} entered terminal status ${pack.status}`,
        );
      }

      await sleep(CERTIFICATE_POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for wildcard certificate ${wildcardHost} to become active`);
  }

  async createTunnel(name: string): Promise<TunnelRecord> {
    return this.request<TunnelRecord>(`/accounts/${this.accountId}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({
        name,
        config_src: "cloudflare",
      }),
    });
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.request(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, {
      method: "DELETE",
    });
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    return this.request<string>(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`);
  }

  async updateTunnelConfiguration(params: {
    tunnelId: string;
    publicHostname: string;
    service: string;
  }): Promise<void> {
    await this.request(`/accounts/${this.accountId}/cfd_tunnel/${params.tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify(
        buildIngressConfig({
          publicHostname: params.publicHostname,
          service: params.service,
        }),
      ),
    });
  }

  async findDnsRecord(zoneId: string, publicHostname: string): Promise<DnsRecord | null> {
    const records = await this.request<DnsRecord[]>(
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(publicHostname)}&per_page=1`,
    );
    return records[0] ?? null;
  }

  async createDnsRecord(params: {
    zoneId: string;
    publicHostname: string;
    tunnelId: string;
    comment: string;
  }): Promise<DnsRecord> {
    return this.request<DnsRecord>(`/zones/${params.zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(
        buildDnsRecordBody({
          publicHostname: params.publicHostname,
          tunnelId: params.tunnelId,
          comment: params.comment,
        }),
      ),
    });
  }

  async deleteDnsRecord(zoneId: string, dnsRecordId: string): Promise<void> {
    await this.request(`/zones/${zoneId}/dns_records/${dnsRecordId}`, {
      method: "DELETE",
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; attempt < CLOUDFLARE_MAX_RETRIES; attempt += 1) {
      try {
        return await this.requestOnce<T>(path, init);
      } catch (error) {
        if (!(error instanceof CloudflareRequestError) || !error.retryable) {
          throw error;
        }

        const isLastAttempt = attempt === CLOUDFLARE_MAX_RETRIES - 1;
        if (isLastAttempt) {
          throw error;
        }

        const delayMs = CLOUDFLARE_RETRY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(`${error.message}; retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }

    throw new Error(`Cloudflare API ${init?.method ?? "GET"} ${path} exhausted retries`);
  }

  private async requestOnce<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error) {
        const isTimeout = error.name === "TimeoutError" || error.name === "AbortError";
        throw new CloudflareRequestError(
          `Cloudflare API ${init?.method ?? "GET"} ${path} failed: ${error.message}`,
          isTimeout,
        );
      }

      throw error;
    }

    const rawBody = await response.text();
    let payload: CloudflareEnvelope<T> | null = null;

    if (rawBody) {
      try {
        payload = JSON.parse(rawBody) as CloudflareEnvelope<T>;
      } catch {
        payload = null;
      }
    }

    this.lastEnvelope = payload;

    if (!response.ok || !payload?.success) {
      const message =
        payload?.errors.map((error) => error.message).join("; ") ||
        rawBody.trim().slice(0, 200) ||
        response.statusText;
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw new CloudflareRequestError(
        `Cloudflare API ${init?.method ?? "GET"} ${path} failed: ${message}`,
        retryable,
      );
    }

    return payload.result;
  }
}

async function rollbackProvisioning(
  cloudflare: CloudflareClient,
  zoneId: string,
  state: RollbackState,
): Promise<void> {
  if (state.dnsRecordId) {
    try {
      await cloudflare.deleteDnsRecord(zoneId, state.dnsRecordId);
    } catch (error) {
      console.warn(
        `rollback warning: failed to delete DNS record ${state.dnsRecordId}: ${String(error)}`,
      );
    }
  }

  if (state.tunnelId) {
    try {
      await cloudflare.deleteTunnel(state.tunnelId);
    } catch (error) {
      console.warn(`rollback warning: failed to delete tunnel ${state.tunnelId}: ${String(error)}`);
    }
  }
}

export async function seedTunnelPool(rawInput: SeedTunnelPoolInput): Promise<SeedSummary> {
  const input = resolveSeedTunnelPoolInput(SeedTunnelPoolInput.parse(rawInput));
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const config = parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: process.env as Record<string, unknown>,
  });
  const semaphoreApiToken = config.sharedApiSecret.exposeSecret();

  if (!cloudflareApiToken) throw new Error("CLOUDFLARE_API_TOKEN is required");
  if (!cloudflareAccountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");

  const semaphore = createSemaphoreClient({
    apiKey: semaphoreApiToken,
    baseURL: input.semaphoreBaseUrl,
  });
  const cloudflare = new CloudflareClient(cloudflareApiToken, cloudflareAccountId, input.zoneName);
  const zoneId = await cloudflare.resolveZoneId();
  console.log(`Resolved Cloudflare zone ${input.zoneName} to ${zoneId}`);
  const certificate = await cloudflare.ensureCertificate(zoneId, input.baseDomain);
  const existingResources = await semaphore.resources.list({ type: input.type });
  const existingSlugs = new Set(existingResources.map((resource) => resource.slug));
  const missingCount = countMissingResources(existingResources.length, input.count);
  const createdHostnames: string[] = [];

  console.log(`Using wildcard certificate ${certificate.id} for *.${input.baseDomain}`);
  console.log(
    `Existing ${input.type} resources: ${existingResources.length}; creating ${missingCount}`,
  );

  for (let index = 0; index < missingCount; index += 1) {
    const slug = pickUnusedSlug(existingSlugs);
    const publicHostname = `${slug}.${input.baseDomain}`;
    const tunnelName = `semaphore-${slug}`;
    const existingDnsRecord = await cloudflare.findDnsRecord(zoneId, publicHostname);

    if (existingDnsRecord) {
      throw new Error(
        `DNS record already exists for ${publicHostname}; refusing to reuse an unknown tunnel`,
      );
    }

    const rollbackState: RollbackState = {
      dnsRecordId: null,
      tunnelId: null,
    };

    try {
      const tunnel = await cloudflare.createTunnel(tunnelName);
      rollbackState.tunnelId = tunnel.id;

      await cloudflare.updateTunnelConfiguration({
        tunnelId: tunnel.id,
        publicHostname,
        service: input.service,
      });

      const dnsRecord = await cloudflare.createDnsRecord({
        zoneId,
        publicHostname,
        tunnelId: tunnel.id,
        comment:
          "Managed by apps/semaphore/scripts/seed-cloudflare-tunnel-pool.ts " +
          `for semaphore type=${input.type}`,
      });
      rollbackState.dnsRecordId = dnsRecord.id;

      const tunnelToken = await cloudflare.getTunnelToken(tunnel.id);
      await semaphore.resources.add({
        type: input.type,
        slug,
        data: CloudflareTunnelData.parse({
          provider: cloudflareTunnelType,
          publicHostname,
          tunnelId: tunnel.id,
          tunnelName,
          tunnelToken,
          service: input.service,
          createdAt: new Date().toISOString(),
        }),
      });

      createdHostnames.push(publicHostname);
      console.log(`Created ${publicHostname}`);
    } catch (error) {
      await rollbackProvisioning(cloudflare, zoneId, rollbackState);
      throw error;
    }
  }

  return {
    existingCount: existingResources.length,
    createdCount: createdHostnames.length,
    alreadyPresentCount: Math.min(existingResources.length, input.count),
    createdHostnames,
  };
}
