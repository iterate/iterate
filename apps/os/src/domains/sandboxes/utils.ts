import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { githubAccessTokenPlaceholder } from "../integrations/utils.ts";
import { SANDBOX_INSTANCE_TYPES, type SandboxInstanceType } from "./instance-types.ts";

// A placeholder projectId used only to round-trip the PATH through the codec.
// Its value never leaves this module — real sandbox names carry the caller's
// projectId — it just has to be a legal projectId so stringify/parse run.
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

// Every sandbox lives under this prefix — the domain-prefix convention every
// other domain already follows (`/secrets/...`, `/repos/...`, `/agents/...`),
// so a project path names exactly one kind of object.
const SANDBOX_PATH_PREFIX = "/sandboxes";

/** The path a `create({ name, instanceType })` mints: the instance-type
 * segment then the caller's name — `/sandboxes/basic/my-pet`. The instance
 * type is part of identity because a Durable Object can never change
 * container class (= instance type). */
export function sandboxPathFor(instanceType: SandboxInstanceType, name: string): string {
  return assertSandboxPath(`${SANDBOX_PATH_PREFIX}/${instanceType}/${name}`);
}

/** The instance-type segment of a sandbox path — which container namespace
 * the sandbox lives in. Throws on paths that don't carry a known instance
 * type (which includes every pre-pet `/sandboxes/cloudflare/...` path). */
export function sandboxInstanceTypeForPath(path: string): SandboxInstanceType {
  const asserted = assertSandboxPath(path);
  const segment = asserted.split("/")[2];
  const instanceType = SANDBOX_INSTANCE_TYPES.find((candidate) => candidate === segment);
  if (instanceType === undefined) {
    throw new Error(
      `sandbox paths carry their instance type as the segment after /sandboxes/ ` +
        `(one of ${SANDBOX_INSTANCE_TYPES.join(", ")}), got "${asserted}"`,
    );
  }
  return instanceType;
}

/**
 * The sandbox path is durable identity (it becomes the Durable Object name).
 * This VALIDATES and never rewrites: the path a caller uses is exactly the
 * path `create` returned, or an error — no added slashes, no canonicalizing.
 *
 * Beyond the prefix, the one real constraint is codec safety. The Durable
 * Object NAME is `{projectId}.iterate{path}`, and recovering identity from a
 * name parses it through `new URL(...)`, which rewrites some paths (a space
 * becomes `%20`, `/x/../y` collapses to `/y`). A path the codec would rewrite
 * would let two spellings mint two Durable Objects for one identity — so
 * reject exactly those, and nothing more.
 */
export function assertSandboxPath(path: string): string {
  if (!path.startsWith(`${SANDBOX_PATH_PREFIX}/`)) {
    throw new Error(
      `sandbox paths start with ${SANDBOX_PATH_PREFIX}/<instanceType>/ ` +
        `(use the exact path itx.sandboxes.create returned), got "${path}"`,
    );
  }
  const roundTripped = DurableObjectNameCodec.parse(
    DurableObjectNameCodec.stringify({ path, projectId: ROUND_TRIP_PROJECT_ID }),
  ).path;
  if (roundTripped !== path) {
    throw new Error(
      `sandbox path must be a stable Durable Object path (the name codec would ` +
        `rewrite "${path}" to "${roundTripped}") — avoid spaces, "..", and "//"`,
    );
  }
  return path;
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
