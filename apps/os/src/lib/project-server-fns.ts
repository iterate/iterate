import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import type { ProjectDeploymentStatus } from "../project-deployment-status.ts";
import { itxAuthFromPrincipal } from "~/auth.ts";
import { getUserPrincipal } from "~/auth/principal.ts";
import { canReadDirectoryProject } from "~/lib/project-directory-authorization.ts";
import { buildProjectWorkerUrl } from "~/lib/project-host-routing.ts";
import {
  chooseRootProjectRedirect,
  createMissingRootRedirectProject,
  type RootProjectRedirectDecision,
} from "~/lib/project-root-redirect.ts";
import { readProjectBySlug } from "~/project-directory.ts";
import { ProjectCollectionRpcTarget } from "~/rpc-targets.ts";
import type { RequestContext } from "~/request-context.ts";

/**
 * SSR-safe project reads as TanStack server functions. itx is client-only (it
 * throws during SSR), so SSR loaders read projects through these instead.
 *
 * These are deliberately minimal: the browser talks to the itx session
 * directly (`session.projects.list()` / `session.projects.get(slug).create()` — see
 * iterate/sdk/itx/react consumers). What remains here is only what MUST run
 * server-side:
 * - `getProjectBySlugServerFn` — the project layout's `beforeLoad` (SSR).
 * - `getRootProjectRedirectServerFn` — the root `/` redirect decision (SSR);
 *   the engine's `session.projects.list()` plus the signup handoff for the
 *   one auth-created project that still needs its OS bootstrap.
 *
 * Both run in the OS worker itself, so they call the itx session objects
 * in-process (`ProjectCollectionRpcTarget` on the middleware-resolved
 * principal) — no loopback HTTP round trip to `/api`, and no capnweb
 * HTTP-batch one-shot limit on follow-up calls.
 *
 * Project deletion is deliberately absent rather than half-implemented:
 * the archival verb (auth-worker archive + engine teardown + UI) has not
 * landed yet — see tasks/os-project-archival.md.
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
  organizationName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deploymentStatus: ProjectDeploymentStatus;
};

type ProjectWithIngressUrl = Project & { ingressUrl: string };

/**
 * The root `/` redirect decision, made entirely server-side so `/` answers
 * with one redirect straight to the project home or projects list before
 * anything renders.
 *
 * A brand-new auth signup creates the user/org/project records in auth before
 * OS has a project stream. When that single auth-known project is still
 * missing, this runs the OS bootstrap through the explicit project handle,
 * waiting only until the project exists (identity registered, directory
 * primed, birth events appended) — the saga runs behind the handle.
 * Single-project users then enter the project home's welcome flow, which
 * renders the remaining bootstrap progress from live state before onboarding.
 *
 * If the deployment-status probe or server-side birth fails, the decision
 * carries an explicit `ensureBirth` handoff. The authenticated welcome page
 * makes the same idempotent create once, so recovery preserves the intended
 * onboarding destination instead of succeeding silently on `/projects`.
 */
export const getRootProjectRedirectServerFn: (input?: {
  data?: { preferredProjectSlug: string | null };
}) => Promise<RootProjectRedirectDecision> = createServerFn({ method: "GET" })
  .validator((input?: { preferredProjectSlug: string | null }) => ({
    preferredProjectSlug: input?.preferredProjectSlug ?? null,
  }))
  .handler(async ({ context, data }) => {
    // The middleware-resolved principal, not the /api cookie door: the root
    // redirect must follow the request's user or scoped operator claims.
    const principal = context.principal;
    if (!principal) return { kind: "projects" };

    try {
      const projects = new ProjectCollectionRpcTarget({
        auth: itxAuthFromPrincipal(principal, {
          allowDirectoryFallback: !context.operatorSession,
        }),
        config: context.config,
        ctx: context.executionCtx,
      });
      const decision = chooseRootProjectRedirect({
        preferredProjectSlug:
          data.preferredProjectSlug ?? getCookie("iterate_recent_project") ?? null,
        projects: await projects.list({ scope: "mine" }),
      });

      if (
        decision.kind === "project" &&
        decision.welcome &&
        (decision.project.deploymentStatus === "missing" || decision.ensureBirth)
      ) {
        try {
          const project = await projects.get(decision.project.slug);
          await createMissingRootRedirectProject(project, {
            projectId: decision.project.id,
            ...organizationSlugForProject(context, decision.project),
          });
          return { ...decision, ensureBirth: false };
        } catch (error) {
          console.error("root redirect: missing project bootstrap failed", {
            projectId: decision.project.id,
            slug: decision.project.slug,
            message: error instanceof Error ? error.message : String(error),
          });
          return { ...decision, ensureBirth: true };
        }
      }

      return decision;
    } catch {
      return { kind: "projects" };
    }
  });

/** A single project the session principal can read, by slug. */
export const getProjectBySlugServerFn: (input: {
  data: { slug: string };
}) => Promise<ProjectWithIngressUrl> = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => input)
  .handler(async ({ context, data }) => {
    const claimed = (getUserPrincipal(context.principal)?.projects ?? []).find(
      (project) => project.slug === data.slug,
    );
    // Single-project reads skip the engine probe (loaders only need slug and
    // ingress URL); `session.projects.list()` carries the real deployment
    // status.
    if (claimed) {
      return withIngressUrl(context, {
        id: claimed.id,
        slug: claimed.slug,
        organizationId: claimed.organizationId ?? null,
        organizationName: null,
        createdAt: null,
        updatedAt: null,
        deploymentStatus: "unknown",
      });
    }

    // Claims miss: consult the directory (KV cache in front of the auth
    // worker — src/project-directory.ts). A platform operator grant or
    // admin-role user may read any project; an ordinary signed-in user may
    // read a project whose owning organization they belong to (covers the
    // stale-claims window right after a create on another device). A scoped
    // operator grant may never use this fallback: its one project claim is
    // the complete authorization boundary.
    const isProjectScopedOperator = context.operatorSession?.grant.kind === "project";
    if (isProjectScopedOperator) throw new Error(`Project ${data.slug} not found`);

    const record = await readProjectBySlug(env.PROJECT_DIRECTORY, data.slug);
    if (!record) throw new Error(`Project ${data.slug} not found`);

    if (
      !canReadDirectoryProject({
        isProjectScopedOperator,
        principal: context.principal,
        recordOrganizationId: record.organizationId,
      })
    ) {
      throw new Error(`Project ${data.slug} not found`);
    }

    return withIngressUrl(context, {
      id: record.id,
      slug: record.slug,
      organizationId: record.organizationId ?? null,
      organizationName: null,
      createdAt: null,
      updatedAt: null,
      deploymentStatus: "unknown",
    });
  });

function withIngressUrl(
  context: Pick<RequestContext, "config">,
  project: Project,
): ProjectWithIngressUrl {
  const ingressUrl =
    buildProjectWorkerUrl({
      projectSlug: project.slug,
      projectHostnameBases: context.config.projectHostnameBases ?? [],
      appBaseUrl: context.config.baseUrl,
    }) ?? `${(context.config.baseUrl ?? "").replace(/\/+$/, "")}/${project.id}`;
  return { ...project, ingressUrl };
}

function organizationSlugForProject(
  context: RequestContext,
  project: { organizationId: string | null },
) {
  if (!project.organizationId) return {};

  const organization = getUserPrincipal(context.principal)?.organizations.find(
    (candidate) => candidate.id === project.organizationId,
  );
  return organization ? { organizationSlug: organization.slug } : {};
}
