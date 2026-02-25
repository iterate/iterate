/**
 * Cloudflare for SaaS Custom Hostnames API wrapper.
 *
 * Registers and deletes custom hostnames on the iterate.app zone so that
 * customer vanity domains (e.g. kaletsky.com) route through CF → os worker
 * with auto-provisioned SSL certificates.
 *
 * @see https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
 * @see https://developers.cloudflare.com/api/resources/custom_hostnames/
 */

import { logger } from "../tag-logger.ts";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ── Types ────────────────────────────────────────────────────────────────

interface CustomHostnameSSL {
  method: "txt" | "http" | "email" | "cname";
  type: "dv";
  wildcard?: boolean;
  status?: string;
  validation_records?: Array<{
    txt_name?: string;
    txt_value?: string;
    http_url?: string;
    http_body?: string;
    cname?: string;
    cname_target?: string;
  }>;
}

interface CustomHostnameResult {
  id: string;
  hostname: string;
  ssl: CustomHostnameSSL;
  status: string;
  created_at: string;
}

interface CFApiResponse<T> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
  result_info?: { page: number; per_page: number; total_count: number; total_pages: number };
}

// ── Config ───────────────────────────────────────────────────────────────

export interface CloudflareCustomHostnameConfig {
  /** CF API token with Custom Hostnames:Edit permission on the zone. */
  apiToken: string;
  /** Zone ID for the iterate.app zone (where CF for SaaS is enabled). */
  zoneId: string;
}

function getConfig(env: { CF_CUSTOM_HOSTNAME_API_TOKEN?: string; CF_CUSTOM_HOSTNAME_ZONE_ID?: string }): CloudflareCustomHostnameConfig | null {
  const apiToken = env.CF_CUSTOM_HOSTNAME_API_TOKEN;
  const zoneId = env.CF_CUSTOM_HOSTNAME_ZONE_ID;
  if (!apiToken || !zoneId) return null;
  return { apiToken, zoneId };
}

function headers(apiToken: string) {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

// ── API calls ────────────────────────────────────────────────────────────

/**
 * Create a custom hostname in the CF for SaaS zone.
 *
 * SSL is set to DV with TXT validation and wildcard enabled so that
 * subdomains like `4096.kaletsky.com` also get valid certs.
 */
export async function createCustomHostname(
  config: CloudflareCustomHostnameConfig,
  hostname: string,
): Promise<CustomHostnameResult> {
  const url = `${CF_API_BASE}/zones/${config.zoneId}/custom_hostnames`;
  const body = {
    hostname,
    ssl: {
      method: "txt",
      type: "dv",
      wildcard: true,
      settings: {
        min_tls_version: "1.2",
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: headers(config.apiToken),
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as CFApiResponse<CustomHostnameResult>;

  if (!data.success) {
    // If hostname already exists, try to find and return it instead of failing
    const isDuplicate = data.errors.some(
      (e) => e.code === 1406 || e.message.includes("already exists"),
    );
    if (isDuplicate) {
      logger.info(`[cf-custom-hostname] Hostname ${hostname} already exists, fetching existing`);
      const existing = await findCustomHostname(config, hostname);
      if (existing) return existing;
    }
    throw new Error(
      `Failed to create custom hostname '${hostname}': ${JSON.stringify(data.errors)}`,
    );
  }

  logger.info(
    `[cf-custom-hostname] Created custom hostname ${hostname} id=${data.result.id} status=${data.result.status}`,
  );
  return data.result;
}

/**
 * Find a custom hostname by exact hostname match.
 */
export async function findCustomHostname(
  config: CloudflareCustomHostnameConfig,
  hostname: string,
): Promise<CustomHostnameResult | null> {
  const url = `${CF_API_BASE}/zones/${config.zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`;
  const response = await fetch(url, {
    headers: headers(config.apiToken),
  });

  const data = (await response.json()) as CFApiResponse<CustomHostnameResult[]>;
  if (!data.success) {
    throw new Error(
      `Failed to find custom hostname '${hostname}': ${JSON.stringify(data.errors)}`,
    );
  }

  return data.result.find((r) => r.hostname === hostname) ?? null;
}

/**
 * Delete a custom hostname from the CF for SaaS zone.
 */
export async function deleteCustomHostname(
  config: CloudflareCustomHostnameConfig,
  hostnameOrId: string,
): Promise<void> {
  // If it looks like a hostname (has dots), find the ID first
  let id = hostnameOrId;
  if (hostnameOrId.includes(".")) {
    const existing = await findCustomHostname(config, hostnameOrId);
    if (!existing) {
      logger.info(
        `[cf-custom-hostname] Hostname ${hostnameOrId} not found in CF, nothing to delete`,
      );
      return;
    }
    id = existing.id;
  }

  const url = `${CF_API_BASE}/zones/${config.zoneId}/custom_hostnames/${id}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: headers(config.apiToken),
  });

  if (!response.ok) {
    const data = (await response.json()) as CFApiResponse<unknown>;
    // 404 = already deleted, not an error
    if (response.status === 404) {
      logger.info(`[cf-custom-hostname] Hostname ${hostnameOrId} already deleted (404)`);
      return;
    }
    throw new Error(
      `Failed to delete custom hostname '${hostnameOrId}': ${JSON.stringify(data.errors)}`,
    );
  }

  logger.info(`[cf-custom-hostname] Deleted custom hostname ${hostnameOrId}`);
}

/**
 * Get the status of a custom hostname (for polling/UI display).
 */
export async function getCustomHostnameStatus(
  config: CloudflareCustomHostnameConfig,
  hostname: string,
): Promise<{ status: string; sslStatus: string; validationRecords: CustomHostnameSSL["validation_records"] } | null> {
  const result = await findCustomHostname(config, hostname);
  if (!result) return null;
  return {
    status: result.status,
    sslStatus: result.ssl.status ?? "unknown",
    validationRecords: result.ssl.validation_records ?? [],
  };
}

// ── High-level operations ────────────────────────────────────────────────

/**
 * Register a project's custom domain with CF for SaaS.
 * Idempotent: if the hostname already exists, returns it.
 *
 * Returns null if CF for SaaS is not configured (missing env vars).
 */
export async function registerProjectCustomDomain(
  env: { CF_CUSTOM_HOSTNAME_API_TOKEN?: string; CF_CUSTOM_HOSTNAME_ZONE_ID?: string },
  customDomain: string,
): Promise<CustomHostnameResult | null> {
  const config = getConfig(env);
  if (!config) {
    logger.info(
      "[cf-custom-hostname] CF for SaaS not configured (missing CF_CUSTOM_HOSTNAME_API_TOKEN or CF_CUSTOM_HOSTNAME_ZONE_ID), skipping",
    );
    return null;
  }
  return createCustomHostname(config, customDomain);
}

/**
 * Remove a project's custom domain from CF for SaaS.
 * Idempotent: if the hostname doesn't exist, does nothing.
 *
 * Returns early if CF for SaaS is not configured.
 */
export async function removeProjectCustomDomain(
  env: { CF_CUSTOM_HOSTNAME_API_TOKEN?: string; CF_CUSTOM_HOSTNAME_ZONE_ID?: string },
  customDomain: string,
): Promise<void> {
  const config = getConfig(env);
  if (!config) {
    logger.info(
      "[cf-custom-hostname] CF for SaaS not configured (missing CF_CUSTOM_HOSTNAME_API_TOKEN or CF_CUSTOM_HOSTNAME_ZONE_ID), skipping",
    );
    return;
  }
  await deleteCustomHostname(config, customDomain);
}
