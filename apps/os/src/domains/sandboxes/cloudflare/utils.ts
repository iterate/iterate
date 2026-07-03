import { normalizePath } from "../../durable-object-names.ts";

/**
 * Every Cloudflare-provider sandbox lives under this scope. The provider
 * segment is part of the address on purpose: `itx.sandboxes.get(path)` always
 * takes the full path (`/sandboxes/cloudflare/whatever`), so a future provider
 * (`/sandboxes/<other>/...`) is a new prefix, not a new API.
 */
const CLOUDFLARE_SANDBOX_PATH_PREFIX = "/sandboxes/cloudflare/";

// The path becomes a URL-shaped Durable Object name, and name PARSING runs it
// through `new URL(...)` — so any segment URL parsing would rewrite ("..",
// ".", empty, "?", "#", percent-escapes, whitespace) must be rejected here.
// Otherwise two spellings (`/x/../y` and `/y`) mint two different Durable
// Object instances that both parse back to the same canonical path.
const SANDBOX_NAME_SEGMENT = /^[a-zA-Z0-9._-]+$/;

/**
 * The sandbox path is durable identity (it becomes the Durable Object name),
 * so this guard sits at the edge where callers choose a path — same contract
 * as `normalizeAgentPath` / `normalizeSecretPath`, plus segment
 * canonicalization because sandbox names are caller-chosen free text.
 */
export function normalizeCloudflareSandboxPath(path: string): string {
  const normalized = normalizePath(path);
  const name = normalized.startsWith(CLOUDFLARE_SANDBOX_PATH_PREFIX)
    ? normalized.slice(CLOUDFLARE_SANDBOX_PATH_PREFIX.length)
    : "";
  const segments = name.split("/");
  const legal =
    name !== "" &&
    segments.every(
      (segment) => SANDBOX_NAME_SEGMENT.test(segment) && segment !== "." && segment !== "..",
    );
  if (!legal) {
    throw new Error(
      `sandbox path must be "${CLOUDFLARE_SANDBOX_PATH_PREFIX}<name>" ` +
        `(name segments: letters, digits, ".", "_", "-"; no "." or ".." segments), got "${normalized}"`,
    );
  }
  return normalized;
}
