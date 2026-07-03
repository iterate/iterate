import { normalizePath } from "../../durable-object-names.ts";

/**
 * Every Cloudflare-provider sandbox lives under this scope. The provider
 * segment is part of the address on purpose: `itx.sandboxes.get(path)` always
 * takes the full path (`/sandboxes/cloudflare/whatever`), so a future provider
 * (`/sandboxes/<other>/...`) is a new prefix, not a new API.
 */
export const CLOUDFLARE_SANDBOX_PATH_PREFIX = "/sandboxes/cloudflare/";

/**
 * The sandbox path is durable identity (it becomes the Durable Object name),
 * so this guard sits at the edge where callers choose a path — same contract
 * as `normalizeAgentPath` / `normalizeSecretPath`.
 */
export function normalizeCloudflareSandboxPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith(CLOUDFLARE_SANDBOX_PATH_PREFIX) || normalized.endsWith("/")) {
    throw new Error(
      `sandbox path must be "${CLOUDFLARE_SANDBOX_PATH_PREFIX}<name>", got "${normalized}"`,
    );
  }
  return normalized;
}
