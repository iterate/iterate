import { createServerFn } from "@tanstack/react-start";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- server functions are one-shot request-scoped calls: a single pipelined batch (authenticate -> list) with no socket lifecycle to manage.
import { newHttpBatchRpcSession } from "capnweb";
import { env } from "cloudflare:workers";
import { authenticateCapnwebAdmin } from "~/auth/admin-auth-cookie.ts";
import { getUserPrincipal } from "~/auth/principal.ts";
import { isOnboardingActive } from "~/lib/onboarding-agent.ts";
import { buildProjectWorkerUrl } from "~/lib/project-host-routing.ts";
import {
  chooseRootProjectRedirect,
  type RootProjectRedirectDecision,
} from "~/lib/project-root-redirect.ts";
import { readProjectBySlug } from "~/project-directory.ts";
import type { ProjectDeploymentStatus, UnauthenticatedOs } from "~/types.ts";
import type { RequestContext } from "~/request-context.ts";

/**
 * SSR-safe project reads as TanStack server functions. itx is client-only (it
 * throws during SSR), so SSR loaders read projects through these instead.
 *
 * These are deliberately minimal: the browser talks to the itx session
 * directly (`session.projects.list()` / `session.projects.create()` — see
 * ~/itx/itx-react.tsx consumers). What remains here is only what MUST run
 * server-side:
 * - `getProjectBySlugServerFn` — the project layout's `beforeLoad` (SSR).
 * - `getRootProjectRedirectServerFn` — the root `/` redirect decision (SSR);
 *   a thin proxy over the engine's `session.projects.list()`, plus the
 *   signup handoff for the one auth-created project that still needs its OS
 *   bootstrap.
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
  customHostname: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deploymentStatus: ProjectDeploymentStatus;
};

type ProjectWithIngressUrl = Project & { ingressUrl: string };

/**
 * The root `/` redirect decision. It runs during SSR (itx is client-only), so
 * it proxies the engine's `session.projects.list()` through one pipelined
 * capnweb HTTP batch that forwards the caller's cookie.
 *
 * A brand-new auth signup creates the user/org/project records in auth before
 * OS has a project stream. When that single auth-known project is still
 * missing, this starts the OS bootstrap with `waitUntilCreated: false`. Single
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
    try {
      const session = engineBatchSession(context);
      const root = session.authenticate({ type: "from-server-cookie" });
      // Explicit "mine": the admin cookie may ride the same request, and the
      // root redirect must follow the signed-in user's claims, never the
      // deployment listing.
      const projects = await root.projects.list({ scope: "mine" });
      const decision = chooseRootProjectRedirect({
        preferredProjectSlug: data.preferredProjectSlug,
        projects,
      });

      if (
        decision.kind === "project" &&
        decision.onboarding &&
        decision.project.deploymentStatus === "ready"
      ) {
        try {
          const project = await root.projects.get(decision.project.id);
          const { state } = await project.processor.snapshot();
          // The agent stream route can render before the agent capability is
          // listed. `onboardingActive` is the phase marker; waiting for the
          // reduced agent list here can wrongly send fresh signups to home.
          decision.onboarding = isOnboardingActive(state);
        } catch {
          decision.onboarding = false;
        }
      }

      if (
        decision.kind === "project" &&
        decision.onboarding &&
        decision.project.deploymentStatus === "missing"
      ) {
        try {
          await root.projects.create({
            projectId: decision.project.id,
            slug: decision.project.slug,
            waitUntilCreated: false,
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
        customHostname: null,
        createdAt: null,
        updatedAt: null,
        deploymentStatus: "unknown",
      });
    }

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

/** Admin cookie, admin-role user, or the capnweb admin header. */
function isAdminContext(context: RequestContext): boolean {
  return (
    context.principal?.type === "admin" ||
    getUserPrincipal(context.principal)?.isAdmin === true ||
    (context.rawRequest != null &&
      authenticateCapnwebAdmin({ config: context.config, request: context.rawRequest }) !== null)
  );
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
  return newHttpBatchRpcSession<UnauthenticatedOs>(
    new Request(`${baseUrl}/api`, {
      method: "POST",
      headers: { cookie },
    }),
  );
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
