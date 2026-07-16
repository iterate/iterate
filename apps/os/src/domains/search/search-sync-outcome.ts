/**
 * Classify only the two expected outcomes of an automatic AI Search sync.
 *
 * `ai_search_not_found` is the observed binding response while project birth
 * provisions its instance asynchronously. `sync_in_cooldown` is Cloudflare's
 * documented 7020 response when a user-triggered sync follows another within
 * 30 seconds. Both are explicit no-ops because the hourly schedule is the
 * durability backstop. Every other rejection remains warning telemetry.
 */
export function expectedSearchSyncSkipReason(
  error: unknown,
): "instance-missing" | "sync-cooldown" | null {
  const message = String(error).toLowerCase();
  if (message.includes("ai_search_not_found")) return "instance-missing";
  if (message.includes("sync_in_cooldown")) return "sync-cooldown";
  return null;
}
