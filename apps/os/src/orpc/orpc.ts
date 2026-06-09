import { ORPCError, implement } from "@orpc/server";
import { osContract } from "@iterate-com/os-contract";
import type { AppContext } from "~/context.ts";
import { resolveActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import { requireProjectScopedAccess } from "~/orpc/project-access.ts";

export const os = implement(osContract).$context<AppContext>();

export const activeOrganizationMiddleware = os.middleware(async ({ context, next }) => {
  const activeOrganization = resolveActiveOrganizationAuth(context);
  if (activeOrganization) {
    return next({
      context: {
        activeOrganization,
      },
    });
  }

  if (context.principal?.type === "user") {
    throw new ORPCError("FORBIDDEN", {
      message: "OS requires an active Organization.",
    });
  }

  throw new ORPCError("UNAUTHORIZED");
});

export const projectScopeMiddleware = os.middleware(async ({ context, next }, input: unknown) => {
  const projectSlugOrId = readProjectSlugOrId(input);
  const project = await requireProjectScopedAccess({ context, projectSlugOrId });

  return next({
    context: {
      projectScope: {
        project,
        projectSlugOrId,
      },
    },
  });
});

function readProjectSlugOrId(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Project-scoped procedures require an object input.",
    });
  }

  const projectSlugOrId = (input as { projectSlugOrId?: unknown }).projectSlugOrId;
  if (typeof projectSlugOrId !== "string" || projectSlugOrId.trim() === "") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Project-scoped procedures require projectSlugOrId.",
    });
  }

  return projectSlugOrId.trim();
}
