import { createServerFn } from "@tanstack/react-start";
import { ProjectsCapability } from "~/domains/projects/project-directory.ts";
import { requireRequestContext } from "~/request-context.ts";

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

export const createProjectServerFn: (input: {
  data: { id?: string; slug: string; organizationSlug?: string };
}) => Promise<ProjectWithIngressUrl> = createServerFn({ method: "POST" })
  .inputValidator((input: { id?: string; slug: string; organizationSlug?: string }) => input)
  .handler(async ({ data }) => {
    return await new ProjectsCapability({ context: requireRequestContext() }).create(data);
  });

/** The session principal's accessible projects (mirrors the former `projects.list`). */
export const listMyProjectsServerFn: (input: {
  data: { limit?: number; offset?: number };
}) => Promise<ProjectListResult> = createServerFn({ method: "GET" })
  .inputValidator((input: { limit?: number; offset?: number }) => input)
  .handler(async ({ data }) => {
    return await new ProjectsCapability({ context: requireRequestContext() }).list(data);
  });

/**
 * Shared query options for the session's accessible projects: the `_app`
 * loader prefetches it (SSR), the sidebar reads it via `useQuery`, both off the
 * same key so hydration matches with no flash.
 */
export function myProjectsQueryOptions() {
  return {
    queryKey: ["my-projects"] as const,
    queryFn: () => listMyProjectsServerFn({ data: { limit: 100, offset: 0 } }),
    staleTime: 30_000,
  };
}

/** A single project the session principal can read, by slug (mirrors `projects.findBySlug`). */
export const getProjectBySlugServerFn: (input: {
  data: { slug: string };
}) => Promise<ProjectWithIngressUrl> = createServerFn({ method: "GET" })
  .inputValidator((input: { slug: string }) => input)
  .handler(async ({ data }) => {
    return await new ProjectsCapability({ context: requireRequestContext() }).findBySlug({
      slug: data.slug,
    });
  });
