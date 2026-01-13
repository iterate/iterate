import { logger } from "../../tag-logger.ts";

type DaytonaSnapshot = {
  id: string;
  name: string;
  createdAt: string;
  state: string;
};

type PaginatedSnapshots = {
  items: DaytonaSnapshot[];
  total: number;
  page: number;
  totalPages: number;
};

type ResolverConfig = {
  apiKey: string;
  baseUrl?: string;
  organizationId?: string;
};

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

// Encapsulated cache to avoid global mutable state pollution in tests
const snapshotCache = (() => {
  let cached: { name: string; prefix: string; timestamp: number } | null = null;

  return {
    get(prefix: string, now: number, ttlMs: number): string | null {
      if (!cached || cached.prefix !== prefix || now - cached.timestamp >= ttlMs) {
        return null;
      }
      return cached.name;
    },
    set(name: string, prefix: string, timestamp: number): void {
      cached = { name, prefix, timestamp };
    },
    clear(): void {
      cached = null;
    },
  };
})();

// Only consider snapshots in these states as usable
const USABLE_SNAPSHOT_STATES = ["ready", "active"];

/**
 * Resolves the latest Daytona snapshot matching a given prefix.
 *
 * Fetches all snapshots from the Daytona API (paginating through all pages),
 * filters by prefix and usable state (ready/active), and returns the most recently created match.
 *
 * Results are cached for 5 minutes to reduce API calls during machine creation bursts.
 */
export async function resolveLatestSnapshot(
  prefix: string,
  config: ResolverConfig,
): Promise<string> {
  const now = Date.now();
  const cacheTtlMs = getCacheTtlMs(prefix);

  // Check cache - must match the same prefix and be within TTL
  const cachedName = cacheTtlMs > 0 ? snapshotCache.get(prefix, now, cacheTtlMs) : null;
  if (cachedName) {
    logger.debug("Using cached snapshot", { name: cachedName });
    return cachedName;
  }

  const baseUrl = config.baseUrl ?? "https://app.daytona.io/api";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  if (config.organizationId) {
    headers["X-Daytona-Organization-ID"] = config.organizationId;
  }

  logger.info("Fetching snapshots from Daytona API", { prefix });

  // Fetch all pages of snapshots
  const allSnapshots: DaytonaSnapshot[] = [];
  let currentPage = 1;
  let totalPages = 1;

  try {
    do {
      const data = await fetchSnapshotsPage(baseUrl, currentPage, headers);
      allSnapshots.push(...data.items);
      totalPages = data.totalPages;
      currentPage++;
    } while (currentPage <= totalPages);
  } catch (err) {
    logger.error("Failed to fetch snapshots from Daytona API", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  logger.debug("Fetched all snapshots", { total: allSnapshots.length, pages: totalPages });

  // Filter by prefix and usable state, then sort by createdAt descending
  const matchingSnapshots = allSnapshots
    .filter((s) => s.name.startsWith(prefix) && USABLE_SNAPSHOT_STATES.includes(s.state))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (matchingSnapshots.length === 0) {
    logger.error("No usable snapshot found matching prefix", {
      prefix,
      totalSnapshots: allSnapshots.length,
      usableStates: USABLE_SNAPSHOT_STATES,
    });
    throw new Error(`No usable snapshot found matching prefix: ${prefix}`);
  }

  const latestSnapshot = matchingSnapshots[0];

  // Update cache
  if (cacheTtlMs > 0) {
    snapshotCache.set(latestSnapshot.name, prefix, now);
  }

  logger.info("Resolved latest snapshot", {
    prefix,
    snapshotName: latestSnapshot.name,
    snapshotState: latestSnapshot.state,
    createdAt: latestSnapshot.createdAt,
    matchCount: matchingSnapshots.length,
  });

  return latestSnapshot.name;
}

/**
 * Clears the snapshot cache. Useful for testing or manual refresh.
 */
export function clearSnapshotCache(): void {
  snapshotCache.clear();
}

function getCacheTtlMs(prefix: string): number {
  const normalized = prefix.toLowerCase();
  if (
    normalized.startsWith("dev-") ||
    normalized.includes("-dev--") ||
    normalized.startsWith("local-")
  ) {
    return 0;
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * Fetches a single page of snapshots from the Daytona API.
 */
async function fetchSnapshotsPage(
  baseUrl: string,
  page: number,
  headers: Record<string, string>,
): Promise<PaginatedSnapshots> {
  const url = new URL(`${baseUrl}/snapshots?limit=100&page=${page}`);
  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Daytona API error: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as PaginatedSnapshots;
}
