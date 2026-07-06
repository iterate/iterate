import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real sandbox names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

// Every sandbox lives under this prefix — the domain-prefix convention every
// other domain already follows (`/secrets/...`, `/repos/...`, `/agents/...`),
// so a project path names exactly one kind of object. Module-local: callers
// spell full paths; only the guard and the agent mapping need the pieces.
const SANDBOX_PATH_PREFIX = "/sandboxes";

// Cloudflare is today's only sandbox provider; the segment keeps room for
// others (the daytona precedent) without renaming everything again.
const CLOUDFLARE_SANDBOX_PREFIX = `${SANDBOX_PATH_PREFIX}/cloudflare`;

/**
 * Where an agent's own sandbox (`itx.sandbox`) lives: the agent path under
 * the Cloudflare sandbox prefix — `/agents/bla` →
 * `/sandboxes/cloudflare/agents/bla`. One function so the birth-certificate
 * mount, the eager mint at birth, and the lifecycle-event fan-out can never
 * disagree on the mapping.
 */
export function agentSandboxPath(agentPath: string): string {
  return normalizeSandboxPath(`${CLOUDFLARE_SANDBOX_PREFIX}${normalizePath(agentPath)}`);
}

/**
 * The agent that owns a sandbox path, or null when the path isn't an agent
 * sandbox — the inverse of {@link agentSandboxPath}. Used to fan an agent
 * sandbox's lifecycle events out to the agent's own journal as well.
 */
export function agentPathForSandbox(sandboxPath: string): string | null {
  return sandboxPath.startsWith(`${CLOUDFLARE_SANDBOX_PREFIX}/agents/`)
    ? sandboxPath.slice(CLOUDFLARE_SANDBOX_PREFIX.length)
    : null;
}

/**
 * The sandbox path is durable identity (it becomes the Durable Object name),
 * so this guard sits at the edge where callers choose a path — same role as
 * `normalizeAgentPath` / `normalizeSecretPath`.
 *
 * Beyond the prefix, the only real constraint is codec safety. The Durable
 * Object NAME is `{projectId}.iterate{path}`, and recovering identity from a
 * name parses it through `new URL(...)`, which rewrites some paths (a space
 * becomes `%20`, `/x/../y` collapses to `/y`). A path that does not survive
 * that round trip would let two spellings mint two Durable Objects that parse
 * back to one canonical path — so reject exactly those, and nothing more.
 * This accepts precisely the paths an agent's own Durable Object can already
 * tolerate (e.g. `/agents/foo@bar`), keeping {@link agentSandboxPath} in
 * lockstep with the agent path it mirrors, rather than a stricter
 * hand-rolled charset.
 */
export function normalizeSandboxPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === SANDBOX_PATH_PREFIX || !normalized.startsWith(`${SANDBOX_PATH_PREFIX}/`)) {
    throw new Error(
      `sandbox paths live under ${SANDBOX_PATH_PREFIX}/ (an agent's sandbox at ` +
        `${SANDBOX_PATH_PREFIX}<agent path>, standalone ones conventionally under ` +
        `${SANDBOX_PATH_PREFIX}/cloudflare/), got "${normalized}"`,
    );
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
