// context/paths.ts — THE PATH LAW, a leaf: what a projectId may look like, which namespace is the
// deployment-global one, who OWNS a context's resources (the owner root every project-level resource
// key is prefixed by), and how a context's Durable Object name is formatted and parsed
// (`DurableObjectNameCodec`). Imported by the edge, the DO, the built-ins and the resolver alike, so
// it imports nothing of theirs.
import { codedError, resolveContextPath } from "iterate/next/lib";

/** The charset a projectId (and, in the global namespace, an owner id) is held to. */
const PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/** The reserved projectId of the deployment-global namespace: the control plane's own contexts —
 *  `/users/<id>`, `/organizations/<id>`, and `/projects/<id>` records — live here. A global context
 *  is an ORDINARY context at this projectId: same codec, same built-ins, same surface as a project's
 *  (`session.user` is exactly `session.projects.get(...)` one namespace over) — except that it is NOT
 *  NAVIGABLE: `cd` is refused for every caller, on a global edge handle (IterateContextRpcTarget.cd)
 *  and inside a global DO (built-ins.ts `cd`). A project's id is minted (`prj_<hex>`), so the word is never one;
 *  `projects.get` refuses it all the same. */
export const GLOBAL_PROJECT_ID = "global";

/** THE RESOURCE OWNER of a context: `id` is the half every project-scoped resource key is prefixed
 *  with (`itx.kv`'s `${id}:`, a secret cell's `${id}:${name}` Durable Object, the Artifacts `${id}.`
 *  repo prefix) and `rootPath` the context whose log holds its secrets catalog. */
export type ResourceScope = { id: string; rootPath: string };

/** THE ONE DERIVATION of a context's resource owner (`ResourceScope`). A project owns its resources
 *  whole — `{ id: projectId, rootPath: "/" }`, every key byte-identical to a plain project prefix.
 *  The global namespace is no owner: one "project" shared by every user's and organization's
 *  context, where the path mask partitions nothing a resource is keyed by — so there the owner is
 *  the OWNER SUBTREE: under `/users/<id>` or `/organizations/<id>` it is `{ id:
 *  "global--<kind>--<id>", rootPath: "/<kind>/<id>" }`, and the global root `/` (or any other global
 *  path) is `{ id: "global", rootPath: "/" }`, the kernel's own. The `--` join is the project-host
 *  label convention (`<app>--<project>`); the owner id is held to the projectId charset, so the
 *  joined id stays inside `[A-Za-z0-9_-]` and the `:` and `.` delimiters still cannot collide, and
 *  no project can spell it (a project id is minted, `prj_<hex>`). User
 *  A's `itx.kv.put('k')` is never user B's `itx.kv.get('k')`, and a user's context IS its own
 *  secrets root. */
export function resourceScope(projectId: string, path: string): ResourceScope {
  if (projectId !== GLOBAL_PROJECT_ID) return { id: projectId, rootPath: "/" };
  const [kind, ownerId] = resolveContextPath("/", path).split("/").slice(1);
  if (!ownerId || (kind !== "users" && kind !== "organizations"))
    return { id: GLOBAL_PROJECT_ID, rootPath: "/" };
  if (!PROJECT_ID.test(ownerId))
    throw codedError(
      "INVALID_CONTEXT",
      `invalid ${kind} id ${JSON.stringify(ownerId)}: only [A-Za-z0-9_-] (it is half of every resource key)`,
    );
  return { id: `${GLOBAL_PROJECT_ID}--${kind}--${ownerId}`, rootPath: `/${kind}/${ownerId}` };
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
