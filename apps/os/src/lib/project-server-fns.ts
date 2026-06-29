import { createServerFn } from "@tanstack/react-start";
import { ProjectsCapability } from "~/domains/projects/project-directory.ts";
import { authenticateCapnwebAdmin } from "~/itx/admin-auth-cookie.ts";
import type { RequestContext } from "~/request-context.ts";

/**
 * SSR-safe project reads as TanStack server functions. itx is client-only (it
 * throws during SSR), so the always-mounted app shell and SSR loaders read
 * projects through these instead. They reuse `ProjectsCapability` — the same
 * session-authed project directory the oRPC product surface used — over the
 * request context's principal + D1.
 *
 * Return types are annotated explicitly for the same reason as
 * fetchRootAuthSnapshot/getSidebarDefaultOpen: server functions consumed by
 * route files must present a Register-independent type (the routeTree.gen.ts
 * footer otherwise collapses the inferred type to `undefined`).
 */

export type Project = {
  id: string;
  slug: string;
  organizationId: string | null;
  customHostname: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  isOrphanedProjectFromAuthService: boolean;
};

export type ProjectWithIngressUrl = Project & { ingressUrl: string };

export type ProjectListResult = { projects: Project[]; total: number };

export const myProjectsQueryKey = ["my-projects"] as const;
export const myProjectsListInput = { limit: 100, offset: 0 } as const;
export const myProjectsStaleTime = 30_000;

export const createMyProjectServerFn: (input: {
  data: { id?: string; slug: string; organizationSlug?: string };
}) => Promise<ProjectWithIngressUrl> = createServerFn({ method: "POST" })
  .validator((input: { id?: string; slug: string; organizationSlug?: string }) => input)
  .handler(async ({ context, data }) => {
    return await new ProjectsCapability({ context: requireUserRequestContext(context) }).create(
      data,
    );
  });

export const deleteProjectServerFn: (input: {
  data: { id: string };
}) => Promise<{ ok: true; id: string; deleted: boolean }> = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ context, data }) => {
    return await new ProjectsCapability({ context }).remove(data);
  });

/** The session principal's accessible projects (mirrors the former `projects.list`). */
export const listMyProjectsServerFn: (input: {
  data: { limit?: number; offset?: number };
}) => Promise<ProjectListResult> = createServerFn({ method: "GET" })
  .validator((input: { limit?: number; offset?: number }) => input)
  .handler(async ({ context, data }) => {
    return await new ProjectsCapability({ context }).list(data);
  });

/** All OS projects, guarded for the admin page. */
export const listAdminProjectsServerFn: (input: {
  data: { limit?: number; offset?: number };
}) => Promise<ProjectListResult> = createServerFn({ method: "GET" })
  .validator((input: { limit?: number; offset?: number }) => input)
  .handler(async ({ context, data }) => {
    return await new ProjectsCapability({ context: adminProjectContext(context) }).listAllForAdmin(
      data,
    );
  });

/** A single project the session principal can read, by slug (mirrors `projects.findBySlug`). */
export const getProjectBySlugServerFn: (input: {
  data: { slug: string };
}) => Promise<ProjectWithIngressUrl> = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => input)
  .handler(async ({ context, data }) => {
    return await new ProjectsCapability({ context }).findBySlug({
      slug: data.slug,
    });
  });

function adminProjectContext(context: RequestContext): RequestContext {
  if (context.rawRequest) {
    const adminCookiePrincipal = authenticateCapnwebAdmin({
      config: context.config,
      request: context.rawRequest,
    });
    if (adminCookiePrincipal) {
      return { ...context, principal: adminCookiePrincipal };
    }
  }
  return context;
}

function requireUserRequestContext(context: RequestContext): RequestContext {
  if (context.principal?.type !== "user") {
    throw new Error("Sign in to create projects.");
  }
  return context;
}
