import { normalizePath } from "../durable-object-names.ts";

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
 *
 * A sandbox can live at ANY non-root project path: sandboxes live in their own
 * Durable Object namespace, so a sandbox path never collides with the stream,
 * agent, or secret at the same path — it NAMES them. `/agents/bla/bla` is that
 * agent's sandbox (`itx.sandbox`); `/sandboxes/cloudflare/whatever` is the
 * conventional home for standalone sandboxes a caller mints directly (the
 * platform's worker builder lives at `/sandboxes/cloudflare/builder`).
 */
export function normalizeSandboxPath(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.slice(1).split("/");
  const legal =
    normalized !== "/" &&
    segments.every(
      (segment) => SANDBOX_PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..",
    );
  if (!legal) {
    throw new Error(
      `sandbox path must be a non-root path of legal segments ` +
        `(letters, digits, ".", "_", "-"), got "${normalized}"`,
    );
  }
  return normalized;
}
