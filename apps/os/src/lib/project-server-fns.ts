import { createServerFn } from "@tanstack/react-start";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- server functions are one-shot request-scoped calls: a single pipelined batch (authenticate -> create -> describe) with no socket lifecycle to manage.
import { newHttpBatchRpcSession } from "capnweb";
import { env } from "cloudflare:workers";
import { authenticateCapnwebAdmin } from "~/auth/admin-auth-cookie.ts";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";
import { getUserPrincipal, type UserPrincipal } from "~/auth/principal.ts";
import { buildProjectWorkerUrl } from "~/lib/project-host-routing.ts";
import { readProjectById, readProjectBySlug } from "~/project-directory.ts";
import type { UnauthenticatedItx } from "~/types.ts";
import type { RequestContext } from "~/request-context.ts";

/**
 * SSR-safe project reads as TanStack server functions. itx is client-only (it
 * throws during SSR), so the always-mounted app shell and SSR loaders read
 * projects through these instead.
 *
 * The auth worker is the source of truth for which projects exist; the session
 * principal's project claims are the fast path for reads. Creation goes
 * through the itx `projects.create` over an HTTP-batch capnweb call
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

/**
 * Whether a project the auth worker knows about actually exists in THIS
 * deployment's engine:
 * - `ready` — the project stream's bootstrap saga ran (`state.created`).
 * - `missing` — the engine has no state for it (e.g. the deployment was
 *   reset while the auth worker kept its rows); it can be set up again.
 * - `unknown` — the probe failed (engine hiccup / access); don't block the
 *   list on it.
 */
export type ProjectDeploymentStatus = "ready" | "missing" | "unknown";

export type Project = {
  id: string;
  slug: string;
  organizationId: string | null;
  organizationName: string | null;
  customHostname: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deploymentStatus: ProjectDeploymentStatus;
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

    // One pipelined HTTP batch into itx, authenticated with the
    // caller's own session cookie: create registers the project with the auth
    // worker (org grant -> claims) and runs the itx bootstrap saga.
    const session = engineBatchSession(context);
    const root = session.authenticate({ type: "from-server-cookie" });
    const project = root.projects.create({
      slug: data.slug,
      ...(data.organizationSlug === undefined ? {} : { organizationSlug: data.organizationSlug }),
      ...(data.id === undefined ? {} : { projectId: data.id }),
    });
    const description = await project.describe();

    // The auth worker may normalize (slugify) the requested slug; create
    // primes the directory with the canonical record before resolving, so
    // read it back rather than echoing the submitted slug into ingress URLs.
    const record = await readProjectById(env.PROJECT_DIRECTORY, description.projectId);

    return withIngressUrl(context, {
      id: description.projectId,
      slug: record?.slug ?? data.slug,
      organizationId: organizationIdForCreate(userPrincipal, data.organizationSlug),
      organizationName: null,
      customHostname: null,
      createdAt: null,
      updatedAt: null,
      deploymentStatus: "ready",
    });
  });

export const deleteProjectServerFn: (input: {
  data: { id: string };
}) => Promise<{ ok: true; id: string; deleted: boolean }> = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(({ data }) => {
    // TODO(task #13): project archival on itx (auth-worker archive
    // + itx teardown). Everything resets during the migration, so deletion
    // is deliberately absent rather than half-implemented.
    throw new Error(`Project deletion is not available yet (project ${data.id}).`);
  });

/**
 * The session principal's accessible projects: claims are the fast path for
 * WHICH projects the caller may reach; a per-project engine probe (one
 * pipelined capnweb batch) says whether each one exists in THIS deployment.
 */
export const listMyProjectsServerFn: (input: {
  data: { limit?: number; offset?: number };
}) => Promise<ProjectListResult> = createServerFn({ method: "GET" })
  .validator((input: { limit?: number; offset?: number }) => input)
  .handler(async ({ context, data }) => {
    const claims = claimedProjects(context);
    const offset = data.offset ?? 0;
    const limit = data.limit ?? claims.length;
    const page = claims.slice(offset, offset + limit);
    const statuses = await probeDeploymentStatuses(
      context,
      page.map((claim) => claim.id),
    );
    return {
      projects: page.map((claim) =>
        withIngressUrl(context, toProject(claim, statuses.get(claim.id) ?? "unknown")),
      ),
      total: claims.length,
    };
  });

/** All auth-side projects (auth worker internal.project.listAll), guarded for the admin page. */
export const listAdminProjectsServerFn: (input: {
  data: { limit?: number; offset?: number };
}) => Promise<ProjectListResult> = createServerFn({ method: "GET" })
  .validator((input: { limit?: number; offset?: number }) => input)
  .handler(async ({ context, data }) => {
    if (!isAdminContext(context)) throw new Error("Admin access required.");

    const result = await createAuthWorkerServiceClient(context).internal.project.listAll({
      ...(data.limit === undefined ? {} : { limit: data.limit }),
      ...(data.offset === undefined ? {} : { offset: data.offset }),
    });
    // Same engine-existence probe as the my-projects list, capped at the page
    // the auth worker returned.
    const statuses = await probeDeploymentStatuses(
      context,
      result.projects.map((project) => project.id),
    );
    return {
      projects: result.projects.map((project) =>
        withIngressUrl(context, {
          id: project.id,
          slug: project.slug,
          organizationId: project.organizationId,
          organizationName: project.organizationName,
          customHostname: null,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          deploymentStatus: statuses.get(project.id) ?? "unknown",
        }),
      ),
      total: result.total,
    };
  });

/** A single project the session principal can read, by slug. */
export const getProjectBySlugServerFn: (input: {
  data: { slug: string };
}) => Promise<ProjectWithIngressUrl> = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => input)
  .handler(async ({ context, data }) => {
    const claimed = claimedProjects(context).find((project) => project.slug === data.slug);
    // Single-project reads skip the engine probe (loaders only need slug and
    // ingress URL); the list endpoints carry the real deployment status.
    if (claimed) return withIngressUrl(context, toProject(claimed, "unknown"));

    // Claims miss: consult the directory (KV cache in front of the auth
    // worker — src/project-directory.ts). Admin sessions (admin cookie
    // or admin-role user) may read any project; a signed-in user may read a
    // project whose owning organization they belong to (covers the
    // stale-claims window right after a create on another device).
    const record = await readProjectBySlug(context.config, env.PROJECT_DIRECTORY, data.slug);
    if (!record) throw new Error(`Project ${data.slug} not found`);

    const userPrincipal = getUserPrincipal(context.principal);
    const memberOfOwningOrg = userPrincipal?.organizations.some(
      (organization) => organization.id === record.organizationId,
    );
    if (!isAdminContext(context) && !memberOfOwningOrg) {
      throw new Error(`Project ${data.slug} not found`);
    }

    return withIngressUrl(context, {
      id: record.id,
      slug: record.slug,
      organizationId: record.organizationId ?? null,
      organizationName: null,
      customHostname: null,
      createdAt: null,
      updatedAt: null,
      deploymentStatus: "unknown",
    });
  });

function claimedProjects(context: { principal?: RequestContext["principal"] }) {
  return getUserPrincipal(context.principal)?.projects ?? [];
}

/** Admin cookie, admin-role user, or the capnweb admin header. */
function isAdminContext(context: RequestContext): boolean {
  return (
    context.principal?.type === "admin" ||
    getUserPrincipal(context.principal)?.isAdmin === true ||
    (context.rawRequest != null &&
      authenticateCapnwebAdmin({ config: context.config, request: context.rawRequest }) !== null)
  );
}

function toProject(
  claim: { id: string; slug: string; organizationId?: string | null },
  deploymentStatus: ProjectDeploymentStatus,
): Project {
  return {
    id: claim.id,
    slug: claim.slug,
    organizationId: claim.organizationId ?? null,
    organizationName: null,
    customHostname: null,
    createdAt: null,
    updatedAt: null,
    deploymentStatus,
  };
}

/**
 * Pure seam for the engine-existence probe: per-project outcomes (`created`
 * from the project processor snapshot, or a rejection) → deployment statuses.
 * A rejected probe means "we could not tell", never "it does not exist".
 */
export function deploymentStatusesFromProbes(
  projectIds: readonly string[],
  outcomes: readonly PromiseSettledResult<boolean>[],
): Map<string, ProjectDeploymentStatus> {
  return new Map(
    projectIds.map((projectId, index) => {
      const outcome = outcomes[index];
      if (!outcome || outcome.status === "rejected") return [projectId, "unknown"];
      return [projectId, outcome.value ? "ready" : "missing"];
    }),
  );
}

/**
 * Probes engine existence for each project in ONE pipelined capnweb HTTP
 * batch: `projects.get(id).processor.snapshot()` → `state.created`. A project
 * stream that was never bootstrapped snapshots to its default state
 * (`created: false`) — that is a "missing" project, not an error. Failures
 * degrade to "unknown" so the caller's list always renders.
 */
async function probeDeploymentStatuses(
  context: RequestContext,
  projectIds: readonly string[],
): Promise<Map<string, ProjectDeploymentStatus>> {
  if (projectIds.length === 0) return new Map();
  try {
    const session = engineBatchSession(context);
    const root = session.authenticate({ type: "from-server-cookie" });
    const outcomes = await Promise.allSettled(
      projectIds.map(async (projectId) => {
        const { state } = await root.projects.get(projectId).processor.snapshot();
        return state.created === true;
      }),
    );
    return deploymentStatusesFromProbes(projectIds, outcomes);
  } catch {
    // No cookie / batch setup failure: statuses are unknowable, but the list
    // must still render.
    return new Map(projectIds.map((projectId) => [projectId, "unknown"]));
  }
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
  if (!cookie) throw new Error("Sign in to reach the project engine.");
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- one-shot pipelined batch per request; no socket lifecycle to manage in a server function.
  return newHttpBatchRpcSession<UnauthenticatedItx>(
    new Request(`${baseUrl}/api/itx`, {
      method: "POST",
      headers: { cookie },
    }),
  );
}
