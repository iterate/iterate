import { createServerFn } from "@tanstack/react-start";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- server functions are one-shot request-scoped calls: a single pipelined batch (authenticate -> create -> describe) with no socket lifecycle to manage.
import { newHttpBatchRpcSession } from "capnweb";
import { env } from "cloudflare:workers";
import { authenticateCapnwebAdmin } from "~/auth/admin-auth-cookie.ts";
import { getUserPrincipal, type UserPrincipal } from "~/auth/principal.ts";
import { buildProjectWorkerUrl } from "~/lib/project-host-routing.ts";
import { readProjectBySlug } from "~/next/project-directory.ts";
import type { UnauthenticatedItx } from "~/next/types.ts";
import type { RequestContext } from "~/request-context.ts";

/**
 * SSR-safe project reads as TanStack server functions. itx is client-only (it
 * throws during SSR), so the always-mounted app shell and SSR loaders read
 * projects through these instead.
 *
 * The auth worker is the source of truth for which projects exist; the session
 * principal's project claims are the fast path for reads. Creation goes
 * through the next engine's `projects.create` over an HTTP-batch capnweb call
 * that forwards the caller's session cookie — the same user-lane door the
 * browser uses. (Future direction: the form calls itx directly and these
 * server functions dissolve; they stay for now so SSR loaders and the app
 * shell keep one entry point.)
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
    const userPrincipal = getUserPrincipal(context.principal);
    if (!userPrincipal) throw new Error("Sign in to create projects.");

    // One pipelined HTTP batch into the next engine, authenticated with the
    // caller's own session cookie: create registers the project with the auth
    // worker (org grant -> claims) and runs the engine bootstrap saga.
    const session = engineBatchSession(context);
    const root = session.authenticate({ type: "from-server-cookie" });
    const project = root.projects.create({
      slug: data.slug,
      ...(data.organizationSlug === undefined ? {} : { organizationSlug: data.organizationSlug }),
      ...(data.id === undefined ? {} : { projectId: data.id }),
    });
    const description = await project.describe();

    return withIngressUrl(context, {
      id: description.projectId,
      slug: data.slug,
      organizationId: organizationIdForCreate(userPrincipal, data.organizationSlug),
      customHostname: null,
      createdAt: null,
      updatedAt: null,
      isOrphanedProjectFromAuthService: false,
    });
  });

export const deleteProjectServerFn: (input: {
  data: { id: string };
}) => Promise<{ ok: true; id: string; deleted: boolean }> = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(({ data }) => {
    // TODO(task #13): project archival on the next engine (auth-worker archive
    // + engine teardown). Everything resets during the migration, so deletion
    // is deliberately absent rather than half-implemented.
    throw new Error(`Project deletion is not available yet (project ${data.id}).`);
  });

/** The session principal's accessible projects (from claims — the fast path). */
export const listMyProjectsServerFn: (input: {
  data: { limit?: number; offset?: number };
}) => Promise<ProjectListResult> = createServerFn({ method: "GET" })
  .validator((input: { limit?: number; offset?: number }) => input)
  .handler(({ context, data }) => {
    const projects = claimedProjects(context).map((claim) =>
      withIngressUrl(context, toProject(claim)),
    );
    const offset = data.offset ?? 0;
    const limit = data.limit ?? projects.length;
    return Promise.resolve({
      projects: projects.slice(offset, offset + limit),
      total: projects.length,
    });
  });

/** All OS projects, guarded for the admin page. */
export const listAdminProjectsServerFn: (input: {
  data: { limit?: number; offset?: number };
}) => Promise<ProjectListResult> = createServerFn({ method: "GET" })
  .validator((input: { limit?: number; offset?: number }) => input)
  .handler(() => {
    // TODO(task #13): auth worker internal.project.listAll powers this.
    return Promise.resolve({ projects: [], total: 0 });
  });

/** A single project the session principal can read, by slug. */
export const getProjectBySlugServerFn: (input: {
  data: { slug: string };
}) => Promise<ProjectWithIngressUrl> = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => input)
  .handler(async ({ context, data }) => {
    const claimed = claimedProjects(context).find((project) => project.slug === data.slug);
    if (claimed) return withIngressUrl(context, toProject(claimed));

    // Claims miss: consult the directory (KV cache in front of the auth
    // worker — src/next/project-directory.ts). Admin sessions (admin cookie
    // or admin-role user) may read any project; a signed-in user may read a
    // project whose owning organization they belong to (covers the
    // stale-claims window right after a create on another device).
    const record = await readProjectBySlug(context.config, env.PROJECT_DIRECTORY, data.slug);
    if (!record) throw new Error(`Project ${data.slug} not found`);

    const userPrincipal = getUserPrincipal(context.principal);
    const isAdmin =
      context.principal?.type === "admin" ||
      userPrincipal?.isAdmin === true ||
      (context.rawRequest != null &&
        authenticateCapnwebAdmin({ config: context.config, request: context.rawRequest }) !== null);
    const memberOfOwningOrg = userPrincipal?.organizations.some(
      (organization) => organization.id === record.organizationId,
    );
    if (!isAdmin && !memberOfOwningOrg) throw new Error(`Project ${data.slug} not found`);

    return withIngressUrl(context, {
      id: record.id,
      slug: record.slug,
      organizationId: record.organizationId ?? null,
      customHostname: null,
      createdAt: null,
      updatedAt: null,
      isOrphanedProjectFromAuthService: false,
    });
  });

function claimedProjects(context: { principal?: RequestContext["principal"] }) {
  return getUserPrincipal(context.principal)?.projects ?? [];
}

function toProject(claim: { id: string; slug: string; organizationId?: string | null }): Project {
  return {
    id: claim.id,
    slug: claim.slug,
    organizationId: claim.organizationId ?? null,
    customHostname: null,
    createdAt: null,
    updatedAt: null,
    isOrphanedProjectFromAuthService: false,
  };
}

function organizationIdForCreate(
  userPrincipal: UserPrincipal,
  organizationSlug: string | undefined,
): string | null {
  const organization = organizationSlug
    ? userPrincipal.organizations.find((candidate) => candidate.slug === organizationSlug)
    : userPrincipal.organizations[0];
  return organization?.id ?? null;
}

function withIngressUrl(
  context: Pick<RequestContext, "config">,
  project: Project,
): ProjectWithIngressUrl {
  const ingressUrl =
    buildProjectWorkerUrl({
      projectSlug: project.slug,
      customHostname: project.customHostname,
      projectHostnameBases: context.config.projectHostnameBases ?? [],
      appBaseUrl: context.config.baseUrl,
    }) ?? `${(context.config.baseUrl ?? "").replace(/\/+$/, "")}/${project.id}`;
  return { ...project, ingressUrl };
}

function engineBatchSession(context: RequestContext) {
  const baseUrl = (context.config.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("baseUrl is not configured");
  const cookie = context.rawRequest?.headers.get("cookie");
  if (!cookie) throw new Error("Sign in to create projects.");
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- one-shot pipelined batch per request; no socket lifecycle to manage in a server function.
  return newHttpBatchRpcSession<UnauthenticatedItx>(
    new Request(`${baseUrl}/api/itx`, {
      method: "POST",
      headers: { cookie },
    }),
  );
}
