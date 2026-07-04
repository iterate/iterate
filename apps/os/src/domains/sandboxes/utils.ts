import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real sandbox names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

/**
 * The sandbox path is durable identity (it becomes the Durable Object name),
 * so this guard sits at the edge where callers choose a path — same role as
 * `normalizeAgentPath` / `normalizeSecretPath`.
 *
 * A sandbox can live at ANY non-root project path: sandboxes live in their own
 * Durable Object namespace, so a sandbox path never collides with the stream,
 * agent, or secret at the same path — it NAMES them. `/agents/bla/bla` is that
 * agent's sandbox (`itx.sandbox`); `/sandboxes/cloudflare/whatever` is the
 * conventional home for standalone sandboxes a caller mints directly (the
 * platform's worker builder lives at `/sandboxes/cloudflare/builder`).
 *
 * The only real constraint is codec safety. The Durable Object NAME is
 * `{projectId}.iterate{path}`, and recovering identity from a name parses it
 * through `new URL(...)`, which rewrites some paths (a space becomes `%20`,
 * `/x/../y` collapses to `/y`). A path that does not survive that round trip
 * would let two spellings mint two Durable Objects that parse back to one
 * canonical path — so reject exactly those, and nothing more. This accepts
 * precisely the paths an agent's own Durable Object can already tolerate
 * (e.g. `/agents/foo@bar`), keeping `itx.sandbox` in lockstep with the agent
 * path it mirrors, rather than a stricter hand-rolled charset.
 */
export function normalizeSandboxPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    throw new Error(`sandbox path must be a non-root path, got "${normalized}"`);
  }
  const roundTripped = DurableObjectNameCodec.parse(
    DurableObjectNameCodec.stringify({ path: normalized, projectId: ROUND_TRIP_PROJECT_ID }),
  ).path;
  if (roundTripped !== normalized) {
    throw new Error(
      `sandbox path must be a stable Durable Object path (it round-trips unchanged ` +
        `through the name codec), got "${normalized}" which normalizes to "${roundTripped}"`,
    );
  }
  return normalized;
}
