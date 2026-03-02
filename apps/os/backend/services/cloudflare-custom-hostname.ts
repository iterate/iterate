/**
 * Cloudflare for SaaS Custom Hostnames API wrapper.
 *
 * Registers and deletes custom hostnames on the iterate.app zone so that
 * customer vanity domains (e.g. kaletsky.com) route through CF → os worker
 * with auto-provisioned SSL certificates.
 *
 * We create **wildcard** custom hostnames (e.g. `kaletsky.com` + `*.kaletsky.com`)
 * because projects use port subdomains like `4096.kaletsky.com`.
 *
 * SSL validation uses **Delegated DCV**: instead of customers managing rotating
 * TXT records every 90 days, they add a single permanent CNAME:
 *   `_acme-challenge.kaletsky.com CNAME kaletsky.com.<DCV_DELEGATION_ID>.dcv.cloudflare.com`
 * CF then places the ACME TXT tokens automatically for initial issuance and renewals.
 *
 * The DCV Delegation ID is a per-zone constant retrieved once from:
 *   `GET /zones/{zone_id}/dcv_delegation/uuid`
 * and stored as `CF_DCV_DELEGATION_ID` env var.
 *
 * @see https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
 * @see https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/delegated-dcv/
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
  /** DCV Delegation UUID for the zone. Used to compute per-domain DCV CNAME targets. */
  dcvDelegationId?: string;
}

function getConfig(env: {
  CF_CUSTOM_HOSTNAME_API_TOKEN?: string;
  CF_CUSTOM_HOSTNAME_ZONE_ID?: string;
  CF_DCV_DELEGATION_ID?: string;
}): CloudflareCustomHostnameConfig | null {
  const apiToken = env.CF_CUSTOM_HOSTNAME_API_TOKEN;
  const zoneId = env.CF_CUSTOM_HOSTNAME_ZONE_ID;
  if (!apiToken || !zoneId) return null;
  return { apiToken, zoneId, dcvDelegationId: env.CF_DCV_DELEGATION_ID };
}

/**
 * Compute the DCV CNAME target for a customer domain.
 *
 * Customers add: `_acme-challenge.<domain> CNAME <domain>.<dcvDelegationId>.dcv.cloudflare.com`
 * This delegates ACME challenge management to CF for automatic wildcard cert issuance/renewal.
 */
export function getDcvCnameTarget(dcvDelegationId: string, hostname: string): string {
  return `${hostname}.${dcvDelegationId}.dcv.cloudflare.com`;
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
    throw new Error(`Failed to find custom hostname '${hostname}': ${JSON.stringify(data.errors)}`);
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
 *
 * Returns hostname status, SSL status, and the DCV CNAME target that
 * customers need to add for Delegated DCV (wildcard cert issuance).
 */
export async function getCustomHostnameStatus(
  config: CloudflareCustomHostnameConfig,
  hostname: string,
): Promise<{
  status: string;
  sslStatus: string;
  validationRecords: CustomHostnameSSL["validation_records"];
  /** The CNAME target for `_acme-challenge.<hostname>` (Delegated DCV). Null if dcvDelegationId not configured. */
  dcvCnameTarget: string | null;
} | null> {
  const result = await findCustomHostname(config, hostname);
  if (!result) return null;
  return {
    status: result.status,
    sslStatus: result.ssl.status ?? "unknown",
    validationRecords: result.ssl.validation_records ?? [],
    dcvCnameTarget: config.dcvDelegationId
      ? getDcvCnameTarget(config.dcvDelegationId, hostname)
      : null,
  };
}

// ── High-level operations ────────────────────────────────────────────────

type CfSaasEnv = {
  CF_CUSTOM_HOSTNAME_API_TOKEN?: string;
  CF_CUSTOM_HOSTNAME_ZONE_ID?: string;
  CF_DCV_DELEGATION_ID?: string;
};

/**
 * Register a project's custom domain with CF for SaaS.
 * Idempotent: if the hostname already exists, returns it.
 *
 * Creates a wildcard custom hostname with TXT-based DCV (requires Delegated DCV
 * CNAME from customer for auto-renewal).
 *
 * Returns null if CF for SaaS is not configured (missing env vars).
 */
export async function registerProjectCustomDomain(
  env: CfSaasEnv,
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
  env: CfSaasEnv,
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

/**
 * Get the DNS records a customer needs to set up for their custom domain.
 *
 * Returns the 3 CNAME records (apex, wildcard, DCV delegation) that the
 * customer needs to add to their DNS. All are permanent — no rotating values.
 */
export function getRequiredDnsRecords(
  env: CfSaasEnv,
  customDomain: string,
): {
  records: Array<{ type: "CNAME"; name: string; value: string; purpose: string }>;
  dcvDelegationConfigured: boolean;
} {
  const config = getConfig(env);
  const dcvDelegationId = config?.dcvDelegationId;

  const records: Array<{ type: "CNAME"; name: string; value: string; purpose: string }> = [
    {
      type: "CNAME",
      name: customDomain,
      value: "cname.iterate.app",
      purpose: "Routes traffic for your domain to Iterate",
    },
    {
      type: "CNAME",
      name: `*.${customDomain}`,
      value: "cname.iterate.app",
      purpose: "Routes traffic for subdomains (e.g. port forwarding) to Iterate",
    },
  ];

  if (dcvDelegationId) {
    records.push({
      type: "CNAME",
      name: `_acme-challenge.${customDomain}`,
      value: getDcvCnameTarget(dcvDelegationId, customDomain),
      purpose: "Delegates SSL certificate validation to Cloudflare (required for wildcard HTTPS)",
    });
  }

  return { records, dcvDelegationConfigured: !!dcvDelegationId };
}
