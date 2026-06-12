// Connect-time access resolution for the server-side door that turns
// credentials into an itx handle (Law 3: auth happens at the boundary,
// nowhere deeper): /api/itx connect + /api/itx/run (fetch.ts) — credentials
// arrive over HTTP/WebSocket, Cap'n Web terminates in the stateless worker.

import type { Client } from "sqlfu";
import { isContextRef, parseContextRef, projectContextRef } from "./coordinates.ts";
import type { ProjectAccess } from "./refs.ts";
import type { ItxRuntime } from "./handle.ts";
import type { Principal } from "~/auth/principal.ts";
import type { RequestContext } from "~/request-context.ts";
import { getProjectById, getProjectBySlug } from "~/db/queries/.generated/index.ts";
import { isProjectId } from "~/domains/projects/project-id.ts";

/** The simplified access model: admin sees all, users see their projects. */
export function accessForPrincipal(principal: Principal): ProjectAccess {
  if (principal.type === "admin" || principal.isAdmin) return "all";
  return principal.projects.map((project) => project.id);
}

/**
 * Resolve a connect/run target to a context ref the caller may hold. The
 * access check happens HERE (auth boundary) and nowhere deeper: a context is
 * accessible iff its namespace (the owning project) is. Accepts a full ref
 * (`<projectId>:/<path>`) or a project id/slug (→ the project root context).
 */
export async function resolveAccessibleContextRef(input: {
  access: ProjectAccess;
  db: Client;
  target: string;
}): Promise<string | null> {
  if (isContextRef(input.target)) {
    const { namespace } = parseContextRef(input.target);
    if (input.access !== "all" && !input.access.includes(namespace)) return null;
    // The namespace must be a real project (a ref grants nothing, but a
    // typo'd namespace should 404 here, not at first dispatch).
    if (!(await getProjectById(input.db, { id: namespace }))) return null;
    return input.target;
  }

  // Classify by prefix: auth mints the canonical "prj_" id, "proj_" is the
  // legacy OS typeid prefix, anything else is a slug.
  const row = isProjectId(input.target)
    ? await getProjectById(input.db, { id: input.target })
    : await getProjectBySlug(input.db, { slug: input.target });
  if (!row) return null;
  if (input.access !== "all" && !input.access.includes(row.id)) return null;
  return projectContextRef(row.id);
}

/**
 * `ctx.exports` as the itx runtime needs it. Requests carry the worker's
 * loopback exports on the request context (there is no importable module-level
 * equivalent — see request-context.ts); handle construction needs them to dial
 * capability entrypoints.
 */
export function requireWorkerExports(
  context: Pick<RequestContext, "workerExports">,
): ItxRuntime["exports"] {
  if (!context.workerExports) {
    throw new Error("Worker exports are not available on this RequestContext.");
  }
  return context.workerExports as unknown as ItxRuntime["exports"];
}
