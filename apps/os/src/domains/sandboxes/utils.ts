import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  githubAccessTokenPlaceholder,
  ITERATE_GITHUB_BOT_COMMIT_AUTHOR,
} from "../integrations/utils.ts";
import type { SandboxInstanceType } from "./instance-types.ts";

/** What `itx.sandboxes.get(path).create` takes — Cloudflare's own vocabulary
 * (instance types and `SandboxOptions.sleepAfter`/`keepAlive`). */
export type SandboxCreateInput = {
  /** Cloudflare instance type; defaults to `basic`. Cannot be changed later. */
  instanceType?: SandboxInstanceType;
  /** Idle time before the container is snapshotted and torn down: a positive
   * number of SECONDS, or `"<n>s"`/`"<n>m"`/`"<n>h"` (e.g. `"30s"`, `"5m"`,
   * `"1h"` — no other units). Defaults to the SDK's 10 minutes. The workspace
   * survives across idle sleep. */
  sleepAfter?: string | number;
  /** Keep the container alive indefinitely (the SDK's `keepAlive`); you must
   * `sleep()` or `destroy()` explicitly. */
  keepAlive?: boolean;
  /** Initial env-var map, merged as if by `setEnvVars` — values are
   * `getSecret(path)` placeholders or non-secret literals, NEVER raw
   * secret material. */
  env?: Record<string, string>;
};

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real sandbox names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

// Every sandbox lives under this collection prefix, matching the addressing
// convention used by `/secrets/...`, `/repos/...`, and `/agents/...`. The
// prefix does not itself declare or create a stream processor.
const SANDBOX_PATH_PREFIX = "/sandboxes";

/** Convert a short name into the path accepted by `sandboxes.get(path)` —
 * `/sandboxes/my-pet`. Names are ONE path segment: every extra segment would
 * materialize an intermediate "folder" stream (the streams system announces a
 * new stream to all its ancestors, minting each one), and a folder that is
 * not a sandbox is meaningless in `/sandboxes/`. The instance type is
 * CONFIGURATION, not identity — it lives on the `create-requested` event and
 * in the durable record, never in the path. */
export function sandboxPathFor(name: string): string {
  return assertSandboxPath(`${SANDBOX_PATH_PREFIX}/${name}`);
}

/** The catalogue idempotency key that claims a sandbox name — one
 * `create-requested` per path, ever (`itx.sandboxes.get(path).create`,
 * rpc-targets.ts). */
export function sandboxCreateClaimKey(path: string): string {
  return `sandbox-create-requested:${path}`;
}

/**
 * The sandbox path is durable identity (it becomes the Durable Object name).
 * This VALIDATES and never rewrites: the path a caller uses is exactly the
 * path `create` returned, or an error — no added slashes, no canonicalizing.
 *
 * Two real constraints:
 * - Exactly `/sandboxes/<name>` with a single-segment name — see
 *   {@link sandboxPathFor} for why nesting is rejected.
 * - Codec safety. The Durable Object NAME is `{projectId}.iterate{path}`, and
 *   recovering identity from a name parses it through `new URL(...)`, which
 *   rewrites some paths (a space becomes `%20`). A path the codec would
 *   rewrite would let two spellings mint two Durable Objects for one
 *   identity — so reject exactly those, and nothing more.
 */
export function assertSandboxPath(path: string): string {
  const name = path.startsWith(`${SANDBOX_PATH_PREFIX}/`)
    ? path.slice(SANDBOX_PATH_PREFIX.length + 1)
    : undefined;
  if (name === undefined || name === "" || name.includes("/")) {
    throw new Error(
      `sandbox paths are exactly ${SANDBOX_PATH_PREFIX}/<name> with a single-segment name ` +
        `(address it with itx.sandboxes.get("/sandboxes/<name>")), got "${path}"`,
    );
  }
  const roundTripped = DurableObjectNameCodec.parse(
    DurableObjectNameCodec.stringify({ path, projectId: ROUND_TRIP_PROJECT_ID }),
  ).path;
  if (roundTripped !== path) {
    throw new Error(
      `sandbox path must be a stable Durable Object path (the name codec would ` +
        `rewrite "${path}" to "${roundTripped}") — avoid spaces and other characters the ` +
        `codec re-encodes`,
    );
  }
  return path;
}

/**
 * Validate a `sleepAfter` value BEFORE it can reach the SDK. The SDK's
 * `setSleepAfter` persists the raw value to Durable Object storage before
 * parsing it, and its constructor re-parses the stored value inside
 * `blockConcurrencyWhile` — so an unparseable value ("1d", "30min") doesn't
 * just fail the call, it permanently crash-loops the DO on every later
 * instantiation (even `destroy()` becomes unreachable; only manual storage
 * surgery recovers). Accepted forms mirror the SDK's parser exactly:
 * a positive number of seconds, or `<digits><s|m|h>`. Lives here (not on the
 * Durable Object) because the collection validates it before appending a
 * `create-requested`, and the Durable Object validates it again at its door.
 */
export function assertValidSleepAfter(value: string | number): void {
  const valid =
    typeof value === "number" ? Number.isFinite(value) && value > 0 : /^\d+[smh]$/.test(value);
  if (!valid) {
    throw new Error(
      `invalid sleepAfter "${value}": pass a positive number of seconds or "<n>s"/"<n>m"/"<n>h" (e.g. "30s", "5m", "1h")`,
    );
  }
}

/**
 * The `GH_TOKEN` value a sandbox plants for a project's GitHub connections,
 * or null when there is none: a `getSecret` placeholder for the connection
 * secret's `accessToken` field, so `gh` (which reads GH_TOKEN natively) and
 * git-over-https against github.com authenticate while the installation token
 * itself is minted and substituted only at the egress door. Several
 * connections: the lexicographically first connection name wins — arbitrary
 * but deterministic, so a container restart can't silently flip which
 * installation a sandbox acts as; `setEnvVars({ GH_TOKEN })` overrides
 * the pick. Pure so the choice is testable without a container.
 */
export function githubTokenEnvForConnections(
  connections: readonly { connection: string; integration: string }[],
): string | null {
  const [first] = connections
    .filter((entry) => entry.integration === "github")
    .map((entry) => entry.connection)
    .sort();
  return first === undefined ? null : githubAccessTokenPlaceholder(first);
}

/**
 * Shell run on every container start: stock git identity + optional GitHub HTTPS
 * auth. Identity is always planted (local commits need an author even without a
 * GitHub connection). Auth only runs when `GH_TOKEN` is set.
 *
 * - **Identity** — {@link ITERATE_GITHUB_BOT_COMMIT_AUTHOR} so commits pushed to
 *   GitHub attribute to the iterate app bot (logo in history). Project slug is
 *   deliberately not in name/email (that would break avatar linking).
 * - **Auth** — Basic `x-access-token:$GH_TOKEN` extraheader. GitHub git smart-HTTP
 *   rejects Bearer; the placeholder is base64-encoded and peeled at egress
 *   (`substituteSecretHeaders`) so token bytes never enter the container.
 */
export const SANDBOX_GIT_CONFIG_SHELL = [
  `git config --global user.name ${shellSingleQuote(ITERATE_GITHUB_BOT_COMMIT_AUTHOR.name)}`,
  `git config --global user.email ${shellSingleQuote(ITERATE_GITHUB_BOT_COMMIT_AUTHOR.email)}`,
  // base64 -w0: single-line output (GNU coreutils on the stock sandbox image).
  // Do not pipe through tr -d "\\n" — that deletes backslash and n, not newlines.
  `if [ -n "$GH_TOKEN" ]; then git config --global http."https://github.com/".extraheader "AUTHORIZATION: Basic $(printf %s "x-access-token:\${GH_TOKEN}" | base64 -w0)"; fi`,
].join(" && ");

/** Quote a literal for POSIX single-quoted shell (safe for `[bot]` emails). */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
