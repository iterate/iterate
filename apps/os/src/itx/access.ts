// Connect-time access resolution for the server-side door that turns
// credentials into an itx handle (Law 3: auth happens at the boundary,
// nowhere deeper): /api/itx connect + /api/itx/run (fetch.ts) — credentials
// arrive over HTTP/WebSocket, Cap'n Web terminates in the stateless worker.
// (The SSR in-process handle that also used this module is gone — itx never
// SSRs anymore, DECISIONS D21.)

import type { Client } from "sqlfu";
import { isChildContextId, type ProjectAccess } from "./protocol.ts";
import type { ContextDO } from "./context-do.ts";
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
 * Resolve a connect/run target to a context id the caller may hold. The
 * access check happens HERE (auth boundary) and nowhere deeper: a child
 * context is accessible iff its owning project is.
 */
export async function resolveAccessibleContextId(input: {
  access: ProjectAccess;
  db: Client;
  env: Env;
  idOrSlug: string;
}): Promise<{ contextId: string; projectId: string } | null> {
  if (isChildContextId(input.idOrSlug)) {
    const contextDo = input.env.ITX_CONTEXT.getByName(
      input.idOrSlug,
    ) as unknown as DurableObjectStub<ContextDO>;
    try {
      const descriptor = await contextDo.descriptor();
      if (input.access !== "all" && !input.access.includes(descriptor.projectId)) return null;
      return { contextId: descriptor.id, projectId: descriptor.projectId };
    } catch {
      return null;
    }
  }

  // Classify by prefix: auth mints the canonical "prj_" id, "proj_" is the
  // legacy OS typeid prefix, anything else is a slug. Treating a "prj_" id as a
  // slug is what 404'd the project REPL connect — the global REPL hits the
  // bare-prefix branch above and so was never affected.
  const row = isProjectId(input.idOrSlug)
    ? await getProjectById(input.db, { id: input.idOrSlug })
    : await getProjectBySlug(input.db, { slug: input.idOrSlug });
  if (!row) return null;
  if (input.access !== "all" && !input.access.includes(row.id)) return null;
  return { contextId: row.id, projectId: row.id };
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
