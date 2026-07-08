import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { githubAccessTokenPlaceholder } from "../integrations/utils.ts";
import type { SandboxInstanceType } from "./instance-types.ts";

/**
 * One sandbox: the bare `@cloudflare/sandbox` Durable Object stub, nothing
 * wrapped on top. Whatever the installed SDK exposes is callable —
 * `exec(command)`, `readFile`/`writeFile`/`listFiles`, `startProcess`,
 * sessions, `gitCheckout`, the code interpreter, `tunnels`, … — so this
 * contract deliberately does not re-declare that surface (same stance as
 * `McpClientRpc`); https://developers.cloudflare.com/sandbox/api/ is
 * the authoritative reference. The image is the stock Cloudflare sandbox
 * image (Ubuntu 22.04, Node 20, Bun, git, curl, jq); install anything else
 * you need at runtime.
 *
 * Platform deltas over stock Cloudflare (everything else passes through):
 * - Sandboxes are created explicitly (`itx.sandboxes.create`), never minted
 *   by addressing.
 * - `/workspace` SURVIVES sleep: snapshotted to storage on `sleep()` or the
 *   idle timer, restored on the next start — where stock Cloudflare loses all
 *   state. Everything outside `/workspace` is ephemeral, and a crash loses
 *   anything since the last snapshot.
 * - `start()` boots the container now instead of lazily; `sleep()` snapshots
 *   and tears down now instead of waiting for `sleepAfter` (the SDK's
 *   `stop()` forwards to it); `destroy()` is permanent — the name is retired.
 * - `__describe()` (the capability-tree convention) carries the durable
 *   record as structured extras ({ path, instanceType, createdAt, sleepAfter }).
 * - `setEnvVars(vars)` is DURABLE here (persisted, re-applied every start,
 *   journaled as a `configured` event); values are conventionally
 *   `getSecret({ path })` placeholders substituted only at egress — real
 *   secret material never enters the container. All sandbox egress flows
 *   through project egress policy; there is no direct internet path.
 * - `mountBucket` and `exposePort` are unavailable (they throw): /workspace
 *   snapshots cover persistence, and `tunnels` covers public URLs.
 */
export type CloudflareSandbox = object;

/** What `itx.sandboxes.create` takes — Cloudflare's own vocabulary
 * (instance types, `SandboxOptions.sleepAfter`/`keepAlive`) plus a name. */
export type SandboxCreateInput = {
  /** The sandbox's name — a single path segment (no `/`); its path becomes
   * `/sandboxes/<name>`. Names are unique per project (across instance
   * types), and destroyed names are retired, not recycled — pick a new one. */
  name: string;
  /** Cloudflare instance type; defaults to `basic`. Cannot be changed later. */
  instanceType?: SandboxInstanceType;
  /** Idle time before the container is snapshotted and torn down: a positive
   * number of SECONDS, or `"<n>s"`/`"<n>m"`/`"<n>h"` (e.g. `"30s"`, `"5m"`,
   * `"1h"` — no other units). Defaults to the SDK's 10 minutes. The workspace
   * survives — see {@link CloudflareSandbox}. */
  sleepAfter?: string | number;
  /** Keep the container alive indefinitely (the SDK's `keepAlive`); you must
   * `sleep()` or `destroy()` explicitly. */
  keepAlive?: boolean;
  /** Initial env-var map, merged as if by `setEnvVars` — values are
   * `getSecret({ path })` placeholders or non-secret literals, NEVER raw
   * secret material. */
  env?: Record<string, string>;
};

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real sandbox names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

// Every sandbox lives under this prefix — the domain-prefix convention every
// other domain already follows (`/secrets/...`, `/repos/...`, `/agents/...`),
// so a project path names exactly one kind of object.
const SANDBOX_PATH_PREFIX = "/sandboxes";

/** The path a `create({ name })` mints: the prefix then the caller's name —
 * `/sandboxes/my-pet`. Names are ONE path segment: every extra segment would
 * materialize an intermediate "folder" stream (the streams system announces a
 * new stream to all its ancestors, minting each one), and a folder that is
 * not a sandbox is meaningless in `/sandboxes/`. The instance type is
 * CONFIGURATION, not identity — it lives on the `create-requested` event and
 * in the durable record, never in the path. */
export function sandboxPathFor(name: string): string {
  return assertSandboxPath(`${SANDBOX_PATH_PREFIX}/${name}`);
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
        `(use the exact path itx.sandboxes.create returned), got "${path}"`,
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
 * Durable Object) because the collection validates it before journaling a
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
