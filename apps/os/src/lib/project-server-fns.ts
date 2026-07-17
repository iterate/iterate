import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { ProjectDeploymentStatus } from "../project-deployment-status.ts";
import { itxAuthFromPrincipal } from "~/auth.ts";
import { getUserPrincipal } from "~/auth/principal.ts";
import { isOnboardingActive } from "~/lib/onboarding-agent.ts";
import { canReadDirectoryProject } from "~/lib/project-directory-authorization.ts";
import { buildProjectWorkerUrl } from "~/lib/project-host-routing.ts";
import {
  chooseRootProjectRedirect,
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
 * directly (`session.projects.list()` / `session.projects.create()` — see
 * iterate/react consumers). What remains here is only what MUST run
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
 * with one redirect straight to the final page (onboarding agent stream,
 * project home, or the projects list) before anything renders.
 *
 * A brand-new auth signup creates the user/org/project records in auth before
 * OS has a project stream. When that single auth-known project is still
 * missing, this starts the OS bootstrap with `waitUntilReady: false`. Single
 * project users then route straight to the onboarding agent stream; that page
 * can render immediately while stream processors catch up.
 *
 * Failures degrade to `/projects`, where the client-side recovery button and
 * auto-recovery still render the real list.
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
          allowDirectoryFallback: context.operatorSession == null,
        }),
        config: context.config,
        ctx: context.executionCtx,
      });
      const decision = chooseRootProjectRedirect({
        preferredProjectSlug: data.preferredProjectSlug,
        projects: await projects.list({ scope: "mine" }),
      });

      if (
        decision.kind === "project" &&
        decision.onboarding &&
        decision.project.deploymentStatus === "ready"
      ) {
        try {
          const project = await projects.get(decision.project.id);
          const { state } = await project.processor.snapshot();
          // The agent stream route can render before the agent capability is
          // listed. `onboardingActive` is the phase marker; waiting for the
          // reduced agent list here can wrongly send fresh signups to home.
          decision.onboarding = isOnboardingActive(state);
        } catch {
          // Do not guess "home" on a transient project snapshot failure. The
          // /projects list still shows the project, while direct home would
          // strand an in-progress signup away from onboarding.
          return { kind: "projects" };
        }
      }

      if (
        decision.kind === "project" &&
        decision.onboarding &&
        decision.project.deploymentStatus === "missing"
      ) {
        try {
          await projects.create({
            projectId: decision.project.id,
            slug: decision.project.slug,
            waitUntilReady: false,
            ...organizationSlugForProject(context, decision.project),
          });
        } catch {
          return { kind: "projects" };
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
