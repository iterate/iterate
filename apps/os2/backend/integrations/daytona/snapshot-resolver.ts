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

// Simple in-memory cache with TTL
let cachedSnapshot: { name: string; prefix: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolves the latest Daytona snapshot matching a given prefix.
 *
 * Fetches all snapshots from the Daytona API, filters by prefix, and returns
 * the most recently created match (sorted by createdAt descending).
 *
 * Results are cached for 5 minutes to reduce API calls during machine creation bursts.
 */
export async function resolveLatestSnapshot(
  prefix: string,
  config: ResolverConfig,
): Promise<string> {
  const now = Date.now();

  // Check cache - must match the same prefix
  if (
    cachedSnapshot &&
    cachedSnapshot.prefix === prefix &&
    now - cachedSnapshot.timestamp < CACHE_TTL_MS
  ) {
    logger.debug("Using cached snapshot", { name: cachedSnapshot.name });
    return cachedSnapshot.name;
  }

  const baseUrl = config.baseUrl ?? "https://app.daytona.io/api";
  const url = new URL(`${baseUrl}/snapshots?limit=100`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  if (config.organizationId) {
    headers["X-Daytona-Organization-ID"] = config.organizationId;
  }

  logger.info("Fetching snapshots from Daytona API", { prefix });

  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("Failed to fetch snapshots from Daytona API", {
      status: response.status,
      error: errorText,
    });
    throw new Error(`Daytona API error: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as PaginatedSnapshots;

  // Filter by prefix and sort by createdAt descending (client-side)
  const matchingSnapshots = data.items
    .filter((s) => s.name.startsWith(prefix))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (matchingSnapshots.length === 0) {
    logger.error("No snapshot found matching prefix", {
      prefix,
      totalSnapshots: data.items.length,
    });
    throw new Error(`No snapshot found matching prefix: ${prefix}`);
  }

  const latestSnapshot = matchingSnapshots[0];

  // Update cache
  cachedSnapshot = { name: latestSnapshot.name, prefix, timestamp: now };

  logger.info("Resolved latest snapshot", {
    prefix,
    snapshotName: latestSnapshot.name,
    createdAt: latestSnapshot.createdAt,
    matchCount: matchingSnapshots.length,
  });

  return latestSnapshot.name;
}

/**
 * Clears the snapshot cache. Useful for testing or manual refresh.
 */
export function clearSnapshotCache(): void {
  cachedSnapshot = null;
}
