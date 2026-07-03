import { normalizePath } from "../../durable-object-names.ts";

/**
 * Every sandbox lives under `/sandboxes/`, and every Cloudflare-provider
 * sandbox under this prefix. The provider segment is part of the path on
 * purpose: `itx.sandboxes.get(path)` always takes the full path — arbitrarily
 * nested (`/sandboxes/cloudflare/bla/bla`) — so a future provider
 * (`/sandboxes/<other>/...`) is a new prefix, not a new API.
 */
const CLOUDFLARE_SANDBOX_PATH_PREFIX = "/sandboxes/cloudflare/";

// The path becomes a URL-shaped Durable Object name, and name PARSING runs it
// through `new URL(...)` — so any segment URL parsing would rewrite ("..",
// ".", empty, "?", "#", percent-escapes, whitespace) must be rejected here.
// Otherwise two spellings (`/x/../y` and `/y`) mint two different Durable
// Object instances that both parse back to the same canonical path.
const SANDBOX_PATH_SEGMENT = /^[a-zA-Z0-9._-]+$/;

/**
 * The sandbox path is durable identity (it becomes the Durable Object name),
 * so this guard sits at the edge where callers choose a path — same contract
 * as `normalizeAgentPath` / `normalizeSecretPath`, plus segment
 * canonicalization because sandbox path segments are caller-chosen free text.
 */
export function normalizeCloudflareSandboxPath(path: string): string {
  const normalized = normalizePath(path);
  const rest = normalized.startsWith(CLOUDFLARE_SANDBOX_PATH_PREFIX)
    ? normalized.slice(CLOUDFLARE_SANDBOX_PATH_PREFIX.length)
    : "";
  const segments = rest.split("/");
  const legal =
    rest !== "" &&
    segments.every(
      (segment) => SANDBOX_PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..",
    );
  if (!legal) {
    throw new Error(
      `sandbox path must be "${CLOUDFLARE_SANDBOX_PATH_PREFIX}..." ` +
        `(segments: letters, digits, ".", "_", "-"), got "${normalized}"`,
    );
  }
  return normalized;
}
