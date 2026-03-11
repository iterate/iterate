/**
 * Caches the GitHub repository → project/machine lookup using the
 * Cloudflare Workers Cache API.
 *
 * - `cache.match` / `cache.put` give per-data-center caching (fast path).
 * - On disconnect / config change we call `cache.delete` for local purge,
 *   plus the Cloudflare Purge API for global invalidation in production.
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/cache/
 * @see https://developers.cloudflare.com/workers/reference/how-the-cache-works/#purge-assets-stored-with-the-cache-api
 */

import type { CloudflareEnv } from "../../../env.ts";
import { logger } from "../../tag-logger.ts";

const CACHE_NAME = "github-repo-lookup";
const CACHE_TTL_SECONDS = 3600; // 1 hour
// Synthetic URL prefix – hostname must belong to our zone so purge-by-URL works.
const CACHE_URL_PREFIX = "https://os.iterate.com/_internal/cache/github-repo-lookup/";

// ── Types ──────────────────────────────────────────────────────────

export type CachedRepoLookup = {
  projectId: string;
  machineId: string;
  machineType: string;
  machineExternalId: string;
  machineMetadata: Record<string, unknown>;
  machineState: string;
};

export type CachedInstallationLookup = CachedRepoLookup;

// ── Helpers ────────────────────────────────────────────────────────

function repoLookupCacheUrl(repoFullName: string): string {
  return `${CACHE_URL_PREFIX}repo/${encodeURIComponent(repoFullName.toLowerCase())}`;
}

function installationLookupCacheUrl(installationId: string): string {
  return `${CACHE_URL_PREFIX}installation/${encodeURIComponent(installationId)}`;
}

async function getCache(): Promise<Cache | null> {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    // caches API unavailable (e.g. in tests or local dev without miniflare)
    return null;
  }
}

// ── Read ───────────────────────────────────────────────────────────

export async function getCachedRepoLookup(
  repoFullName: string,
): Promise<CachedRepoLookup[] | null> {
  const cache = await getCache();
  if (!cache) return null;

  const url = repoLookupCacheUrl(repoFullName);
  const response = await cache.match(new Request(url));
  if (!response) return null;

  try {
    return (await response.json()) as CachedRepoLookup[];
  } catch {
    return null;
  }
}

export async function getCachedInstallationLookup(
  installationId: string,
): Promise<CachedInstallationLookup[] | null> {
  const cache = await getCache();
  if (!cache) return null;

  const url = installationLookupCacheUrl(installationId);
  const response = await cache.match(new Request(url));
  if (!response) return null;

  try {
    return (await response.json()) as CachedInstallationLookup[];
  } catch {
    return null;
  }
}

// ── Write ──────────────────────────────────────────────────────────

export async function setCachedRepoLookup(
  repoFullName: string,
  data: CachedRepoLookup[],
): Promise<void> {
  const cache = await getCache();
  if (!cache) return;

  const url = repoLookupCacheUrl(repoFullName);
  const response = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(new Request(url), response);
}

export async function setCachedInstallationLookup(
  installationId: string,
  data: CachedInstallationLookup[],
): Promise<void> {
  const cache = await getCache();
  if (!cache) return;

  const url = installationLookupCacheUrl(installationId);
  const response = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(new Request(url), response);
}

// ── Purge ──────────────────────────────────────────────────────────

/**
 * Purge a cached repo lookup from all Cloudflare data centers.
 *
 * In production this hits the Cloudflare Purge API for global invalidation.
 * Locally / in dev, `cache.delete()` handles the local data center.
 */
export async function purgeRepoLookupCache(
  repoFullName: string,
  env: CloudflareEnv,
): Promise<void> {
  const url = repoLookupCacheUrl(repoFullName);
  await purgeUrl(url, env);
}

export async function purgeInstallationLookupCache(
  installationId: string,
  env: CloudflareEnv,
): Promise<void> {
  const url = installationLookupCacheUrl(installationId);
  await purgeUrl(url, env);
}

async function purgeUrl(url: string, env: CloudflareEnv): Promise<void> {
  // Always do local cache.delete (fast, covers the current data center)
  const cache = await getCache();
  if (cache) {
    await cache.delete(new Request(url));
  }

  // In production, also call the Cloudflare Purge API for global invalidation
  const apiToken = (env as Record<string, unknown>).CLOUDFLARE_API_TOKEN as string | undefined;
  const zoneId = (env as Record<string, unknown>).CLOUDFLARE_ZONE_ID as string | undefined;

  if (!apiToken || !zoneId) {
    logger.debug("[GitHub Repo Cache] No CLOUDFLARE_API_TOKEN/ZONE_ID, skipping global purge", {
      url,
    });
    return;
  }

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files: [url] }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      logger.warn(`[GitHub Repo Cache] Purge API failed (${response.status}): ${body.slice(0, 500)}`);
    } else {
      logger.debug("[GitHub Repo Cache] Global purge succeeded", { url });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[GitHub Repo Cache] Purge API error: ${message}`);
  }
}
