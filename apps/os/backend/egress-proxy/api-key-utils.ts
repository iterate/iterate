/**
 * API key utilities for the egress proxy.
 * Extracted from trpc/routers/machine.ts to avoid pulling in the full router
 * and its transitive TanStack dependencies.
 */

/**
 * Parse token ID from API key.
 * API key format: pak_<tokenId>_<randomHex>
 * Example: pak_pat_abc123_deadbeef -> pat_abc123
 */
export function parseTokenIdFromApiKey(apiKey: string): string | null {
  const match = apiKey.match(/^pak_(pat_[a-z0-9]+)_[a-f0-9]+$/);
  return match ? match[1] : null;
}
