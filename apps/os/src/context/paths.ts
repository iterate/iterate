// context/paths.ts — THE PATH LAW, a leaf: what a projectId may look like, which namespace is the
// deployment-global one, who OWNS a context's resources (the owner root every project-level resource
// key is prefixed by), and how a context's Durable Object name is formatted and parsed
// (`DurableObjectNameCodec`). Imported by the edge, the DO, the built-ins and the resolver alike, so
// it imports nothing of theirs.
import { codedError, resolveContextPath } from "iterate/lib";

/** The charset a projectId (and, in the global namespace, an owner id) is held to. */
const PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/** The reserved projectId of the deployment-global namespace: the account (`/users/<id>`) and
 *  organization (`/organizations/<id>`) contexts live here. A global context
 *  is an ORDINARY context at this projectId: same codec, same built-ins, same surface as a project's
 *  (`session.user` is exactly `session.projects.get(...)` one namespace over) — except that it is NOT
 *  NAVIGABLE: `cd` is refused for every caller, on a global edge handle (IterateContextRpcTarget.cd)
 *  and inside a global DO (built-ins.ts `cd`). A catalog project's id is minted (`prj_<hex>`), but
 *  the admin secret addresses a project the catalog never heard of by any id, so `projects.get` and
 *  the MCP `project` refuse the word, and `DurableObjectNameCodec.address` refuses every
 *  `global--…` id (`GLOBAL_OWNER_ID_PREFIX`). */
export const GLOBAL_PROJECT_ID = "global";
/** What every global owner subtree's resource id starts with (`resourceScope`). */
const GLOBAL_OWNER_ID_PREFIX = `${GLOBAL_PROJECT_ID}--`;

/** THE RESOURCE OWNER of a context: `id` is the half every project-scoped resource key is prefixed
 *  with (`itx.kv`'s `${id}:`, a secret cell's `${id}:${name}` Durable Object, the Artifacts `${id}.`
 *  repo prefix) and `rootPath` the context whose log holds its secrets catalog. `kind` and `ownerId`
 *  say who that is: a project, a user's or an organization's subtree, or the global root. */
export type ResourceScope = {
  id: string;
  rootPath: string;
  kind: "project" | "users" | "organizations" | "global";
  ownerId: string;
};

/** THE ONE DERIVATION of a context's resource owner (`ResourceScope`). A project owns its resources
 *  whole — `{ id: projectId, rootPath: "/" }`, every key byte-identical to a plain project prefix.
 *  The global namespace is no owner: one "project" shared by every user's and organization's
 *  context, where the path mask partitions nothing a resource is keyed by — so there the owner is
 *  the OWNER SUBTREE: under `/users/<id>` or `/organizations/<id>` it is `{ id:
 *  "global--<kind>--<id>", rootPath: "/<kind>/<id>" }`, and the global root `/` (or any other global
 *  path) is `{ id: "global", rootPath: "/" }`, the kernel's own. The `--` join is the project-host
 *  label convention (`<routingSlug>--<project>`); the owner id is held to the projectId charset, so the
 *  joined id stays inside `[A-Za-z0-9_-]` and the `:` and `.` delimiters still cannot collide, and
 *  no project can spell it (`DurableObjectNameCodec.address` refuses the prefix). User
 *  A's `itx.kv.put('k')` is never user B's `itx.kv.get('k')`, and a user's context IS its own
 *  secrets root. */
export function resourceScope(projectId: string, path: string): ResourceScope {
  if (projectId !== GLOBAL_PROJECT_ID)
    return { id: projectId, rootPath: "/", kind: "project", ownerId: projectId };
  const [kind, ownerId] = resolveContextPath("/", path).split("/").slice(1);
  if (!ownerId || (kind !== "users" && kind !== "organizations"))
    return { id: GLOBAL_PROJECT_ID, rootPath: "/", kind: "global", ownerId: GLOBAL_PROJECT_ID };
  if (!PROJECT_ID.test(ownerId))
    throw codedError(
      "INVALID_CONTEXT",
      `invalid ${kind} id ${JSON.stringify(ownerId)}: only [A-Za-z0-9_-] (it is half of every resource key)`,
    );
  return {
    id: `${GLOBAL_OWNER_ID_PREFIX}${kind}--${ownerId}`,
    rootPath: `/${kind}/${ownerId}`,
    kind,
    ownerId,
  };
}

/** The ancestors a context announces itself to (`itx/child-created`), root first: `/a/b/c`
 *  → `/`, `/a`, `/a/b`; `/` has none. */
export function ancestorPathsOf(path: string): string[] {
  const segments = resolveContextPath("/", path).split("/").filter(Boolean);
  return segments.map((_, index) => `/${segments.slice(0, index).join("/")}`);
}

/** A context's path relative to its owner's root (`resourceScope`) — what a secret's placeholder
 *  spells: `/secrets/shop` for a project's `/secrets/shop` and a user's `/users/<id>/secrets/shop`
 *  alike. */
export function pathUnderOwner(scope: ResourceScope, path: string): string {
  return scope.rootPath === "/" ? path : path.slice(scope.rootPath.length);
}

// ── durable object names ── the ONE place a context DO name is formatted and parsed. A context is
// addressed by a faux URL `{projectId}.iterate{path}`:
//
//   prj_demo.iterate/                     → project root
//   prj_demo.iterate/agents/support-bot   → a context below it
//
// The projectId is always the host prefix, so a name alone says which project the context
// belongs to — the basis of isolation.

const DURABLE_OBJECT_HOST_SUFFIX = ".iterate";

/** A parsed DO address. `name` is its own canonical string form — parse once, carry both
 *  halves together (no separate re-stringify field at call sites). */
export type DurableObjectAddress = { projectId: string; path: string; name: string };

export const DurableObjectNameCodec = {
  /** Formats the project-scoped Durable Object name `{projectId}.iterate{path}` — the path in the
   *  CANONICAL form `cd` resolves to (`resolveContextPath`), so `/a`, `/a/`, `/a/./` and `a` are ONE
   *  name and no entry point (the `?context=` query included) can mint a twin DO for a logical
   *  context. */
  stringify({ projectId, path }: { projectId: string; path: string }): string {
    return `${projectId}${DURABLE_OBJECT_HOST_SUFFIX}${resolveContextPath("/", path)}`;
  },
  /** The canonical, validated address `{ projectId, path, name }` for a context, built from parts a
   *  caller already holds — path canonicalized, projectId validated, the DO `name` carried. The
   *  DIRECT form of `parse(stringify({ projectId, path }))`, with no string to round-trip through. */
  address({ projectId, path }: { projectId: string; path: string }): DurableObjectAddress {
    // The projectId is the kv/secret prefix AND a loader-cacheKey component — a ":" (or worse) in it
    // collapses the isolation wall (prj_x + key "a:b" would address the same cell as project prj_x:a
    // + key "b"). Gated here, the ONE place every name is parsed (`parse` routes through it).
    if (!PROJECT_ID.test(projectId))
      throw codedError(
        "INVALID_CONTEXT",
        `invalid projectId ${JSON.stringify(projectId)}: only [A-Za-z0-9_-] (a ":" would breach the kv/secret isolation wall)`,
      );
    // A project spelled like a global owner subtree's resource id (`global--users--<id>`) would
    // share that user's or organization's kv, secrets and files.
    if (projectId.startsWith(GLOBAL_OWNER_ID_PREFIX))
      throw codedError(
        "INVALID_CONTEXT",
        `invalid projectId ${JSON.stringify(projectId)}: "${GLOBAL_OWNER_ID_PREFIX}" is the global namespace's resource prefix`,
      );
    const parts = { projectId, path: resolveContextPath("/", path) };
    return { ...parts, name: DurableObjectNameCodec.stringify(parts) };
  },
  /** Parses a Durable Object name. A bare name (no `.iterate`) is that project's root — what
   *  `projects.get("prj_x")` hands in. */
  parse(name: string): DurableObjectAddress {
    const i = name.indexOf(DURABLE_OBJECT_HOST_SUFFIX);
    return i === -1
      ? DurableObjectNameCodec.address({ projectId: name, path: "/" })
      : DurableObjectNameCodec.address({
          projectId: name.slice(0, i),
          path: name.slice(i + DURABLE_OBJECT_HOST_SUFFIX.length),
        });
  },
};
