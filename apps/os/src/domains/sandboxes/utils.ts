import { normalizePath } from "../durable-object-names.ts";

/**
 * Sandbox paths are stream paths — the same durable-identity contract as
 * `normalizeAgentPath` / `normalizeSecretPath`: a `/sandboxes/` prefix guard
 * at the edge where callers choose a path, nothing more. The segment after
 * the prefix is convention, not enforcement (today everything lives under
 * `/sandboxes/cloudflare/...`; the platform's worker builder lives at
 * `/sandboxes/cloudflare/builder`).
 */
export function normalizeSandboxPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/sandboxes/")) {
    throw new Error(`sandbox path must start with "/sandboxes/", got "${normalized}"`);
  }
  return normalized;
}
