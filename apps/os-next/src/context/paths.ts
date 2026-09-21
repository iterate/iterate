// context/paths.ts — THE PATH LAW, a leaf: what a projectId may look like, which namespace is the
// deployment-global one, who OWNS a context's resources (the owner root every project-level resource
// key is prefixed by), and how a `cd` target resolves against a path. Imported by the edge, the DO,
// the built-ins and the resolver alike, so it imports nothing of theirs.
import { codedError, resolveContextPath } from "iterate/next/lib";

/** The charset a projectId (and, in the global namespace, an owner id) is held to. */
export const PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/** The reserved projectId of the deployment-global namespace: the control plane's own contexts —
 *  `/users/<id>`, `/organizations/<id>`, and `/projects/<id>` records — live here. A global context
 *  is an ORDINARY context at this projectId: same codec, same built-ins, same surface as a project's
 *  (`session.user` is exactly `session.projects.get(...)` one namespace over) — except that it is NOT
 *  NAVIGABLE: `cd` is refused on a global edge handle (IterateContextRpcTarget.cd) and, for a
 *  principal, inside a global DO (built-ins.ts `cd`). A project's id is minted (`prj_<hex>`), so the word is never one;
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
