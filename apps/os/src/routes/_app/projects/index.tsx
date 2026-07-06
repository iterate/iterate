import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { useAuthClient } from "@iterate-com/auth/client";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { toast } from "@iterate-com/ui/components/sonner";
import type { ProjectListEntry } from "../../../project-deployment-status.ts";
import { ONBOARDING_AGENT_PATH, hasActiveOnboardingAgent } from "~/lib/onboarding-agent.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { getRootProjectRedirectServerFn } from "~/lib/project-server-fns.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import {
  fetchProjectsList,
  projectsListQueryKey,
  projectsListStaleTime,
} from "~/lib/projects-query.ts";
import { connectItxBrowser, reconnectItx } from "~/itx/itx-react.tsx";

type OrganizationSummary = {
  id: string;
  name?: string | null;
  slug: string;
};

const NO_ORGANIZATIONS: OrganizationSummary[] = [];

export const Route = createFileRoute("/_app/projects/")({
  ssr: false,
  loader: async () => {
    const decision = await getRootProjectRedirectServerFn({
      data: { preferredProjectSlug: null },
    });

    if (decision.kind === "project") {
      if (decision.onboarding) {
        throw redirect({
          to: "/projects/$projectSlug/agents/streams/$",
          params: {
            projectSlug: decision.project.slug,
            _splat: ONBOARDING_AGENT_PATH,
          },
          search: {},
          replace: true,
        });
      }

      throw redirect({
        to: "/projects/$projectSlug",
        params: { projectSlug: decision.project.slug },
        search: {},
        replace: true,
      });
    }

    return {
      routeConfig: await getPublicRouteConfig(),
    };
  },
  pendingComponent: ProjectsIndexPending,
  component: ProjectsIndexPage,
});

function ProjectsIndexPending() {
  return (
    <section className="p-4 text-sm text-muted-foreground" data-spinner="true">
      Loading projects...
    </section>
  );
}

function buildProjectHostname(input: { slug: string; projectHostnameBases: readonly string[] }) {
  const base = input.projectHostnameBases[0];
  if (!base) return null;
  return `${input.slug}.${normalizeProjectHostnameBase(base)}`;
}

function ProjectsIndexPage() {
  const { routeConfig } = Route.useLoaderData();
  const navigate = useNavigate();
  const { session } = useAuthClient();
  const organizations = session?.authenticated ? session.session.organizations : NO_ORGANIZATIONS;
  const isAdmin = session?.authenticated ? session.user.isAdmin === true : false;
  const queryClient = useQueryClient();
  // The list comes straight from the itx session (`session.projects.list()`),
  // shared with the app sidebar through the one projects cache entry.
  const { data, isPending } = useQuery({
    queryKey: projectsListQueryKey,
    queryFn: fetchProjectsList,
    staleTime: projectsListStaleTime,
  });
  const projects = data ?? [];
  const hasProjects = projects.length > 0;
  const organizationSlugFor = useCallback(
    (project: ProjectListEntry) =>
      project.organizationId
        ? organizations.find((organization) => organization.id === project.organizationId)?.slug
        : undefined,
    [organizations],
  );

  // "Set up" for a project the auth worker knows about but this deployment's
  // engine does not: re-run `projects.create` on the itx session with the
  // claim's exact id and slug. The auth side is idempotent
  // (createForOrganization returns the existing row), then the engine
  // bootstrap saga runs.
  const recoverProject = useMutation({
    mutationFn: async (project: ProjectListEntry) => {
      const organizationSlug = organizationSlugFor(project);
      const itx = await connectItxBrowser();
      await itx.projects.create({
        projectId: project.id,
        slug: project.slug,
        ...(organizationSlug === undefined ? {} : { organizationSlug }),
      });
    },
    onSuccess: async () => {
      // Drop the global socket BEFORE refetching so the list re-dials with
      // the widened access, then invalidate the shared cache entry.
      reconnectItx();
      await queryClient.invalidateQueries({ queryKey: projectsListQueryKey });
      toast.success("Project set up");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  // Auth onboarding creates the project container on auth only, so a
  // brand-new user's first project always arrives here as "missing" — run
  // the set-up for them instead of asking them to press the button. The single
  // project case is owned by the onboarding redirect below; this fallback keeps
  // multi-project recovery automatic without hijacking users into one project.
  const autoSetUpProjectIds = useRef(new Set<string>());
  const recoverProjectMutate = recoverProject.mutate;
  useEffect(() => {
    if ((data ?? []).length === 1) return;
    for (const project of data ?? []) {
      if (project.deploymentStatus !== "missing") continue;
      if (autoSetUpProjectIds.current.has(project.id)) continue;
      autoSetUpProjectIds.current.add(project.id);
      recoverProjectMutate(project);
    }
  }, [data, recoverProjectMutate]);

  const onboardingRedirectInFlightProjectIds = useRef(new Set<string>());
  const [onboardingRedirectRetry, retryOnboardingRedirect] = useReducer((value) => value + 1, 0);
  useEffect(() => {
    const project = data?.length === 1 ? data[0]! : null;
    if (project == null) return;
    if (project.deploymentStatus === "unknown") return;
    if (onboardingRedirectInFlightProjectIds.current.has(project.id)) return;
    onboardingRedirectInFlightProjectIds.current.add(project.id);

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const finishRedirectAttempt = () => {
      onboardingRedirectInFlightProjectIds.current.delete(project.id);
    };
    const retryRedirectAttempt = () => {
      if (cancelled) return;
      finishRedirectAttempt();
      retryTimer = setTimeout(() => {
        if (!cancelled) retryOnboardingRedirect();
      }, 1_000);
    };

    void (async () => {
      let shouldRetry = false;
      try {
        const itx = await connectItxBrowser();
        if (project.deploymentStatus === "missing") {
          const organizationSlug = organizationSlugFor(project);
          await itx.projects.create({
            projectId: project.id,
            slug: project.slug,
            waitUntilCreated: false,
            ...(organizationSlug === undefined ? {} : { organizationSlug }),
          });
        } else {
          const projectItx = await itx.projects.get(project.id);
          let inOnboarding = false;
          for (let attempt = 0; attempt < 20 && !cancelled; attempt += 1) {
            const { state } = await projectItx.processor.snapshot();
            if (!state.onboardingActive) return;
            if (hasActiveOnboardingAgent(state)) {
              inOnboarding = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (!inOnboarding) {
            shouldRetry = true;
            return;
          }
        }

        if (cancelled) return;
        await navigate({
          to: "/projects/$projectSlug/agents/streams/$",
          params: { projectSlug: project.slug, _splat: ONBOARDING_AGENT_PATH },
          search: {},
          replace: true,
        });
      } catch {
        shouldRetry = true;
      } finally {
        if (shouldRetry) {
          retryRedirectAttempt();
        } else {
          finishRedirectAttempt();
        }
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer != null) clearTimeout(retryTimer);
      finishRedirectAttempt();
    };
  }, [data, navigate, onboardingRedirectRetry, organizationSlugFor]);

  return (
    <section className="space-y-5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Your projects</h2>
          <p className="text-sm text-muted-foreground">
            Projects you can access, and whether they exist in this deployment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <Button
              nativeButton={false}
              type="button"
              variant="outline"
              size="sm"
              render={<Link to="/admin/projects" />}
            >
              Go to admin project list
            </Button>
          ) : null}
          {hasProjects ? (
            <Button
              nativeButton={false}
              type="button"
              size="sm"
              render={<Link to="/new-project" />}
            >
              New project
            </Button>
          ) : null}
        </div>
      </div>

      {isPending ? (
        <div className="text-sm text-muted-foreground" data-spinner="true">
          Loading projects...
        </div>
      ) : !hasProjects ? (
        <div className="rounded-xl border border-dashed bg-card/60 px-6 py-14 text-center">
          <div className="mx-auto flex max-w-md flex-col items-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <FolderPlus className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold">No projects yet</h3>
              <p className="text-sm text-muted-foreground">
                Create your first project to start using OS.
              </p>
            </div>
            <Button
              nativeButton={false}
              type="button"
              size="sm"
              render={<Link to="/new-project" />}
            >
              Create new project
            </Button>
          </div>
        </div>
      ) : (
        <ProjectsTable
          projects={projects}
          organizations={organizations}
          projectHostnameBases={routeConfig.projectHostnameBases}
          recoverProject={recoverProject}
        />
      )}
    </section>
  );
}

const PROJECT_ROW_GRID =
  "grid min-w-[980px] grid-cols-[240px_220px_minmax(220px,1fr)_220px_200px] items-start gap-3 px-3";

function ProjectsTable({
  organizations,
  projectHostnameBases,
  projects,
  recoverProject,
}: {
  organizations: OrganizationSummary[];
  projectHostnameBases: readonly string[];
  projects: ProjectListEntry[];
  recoverProject: UseMutationResult<unknown, Error, ProjectListEntry>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <div
        className={`${PROJECT_ROW_GRID} border-b bg-muted/40 py-2 text-xs font-medium text-muted-foreground`}
      >
        <div>Project</div>
        <div>Organization</div>
        <div>Hostname</div>
        <div>Status</div>
        <div />
      </div>
      {projects.map((project) => {
        const hostname = buildProjectHostname({
          slug: project.slug,
          projectHostnameBases,
        });

        return (
          <div
            key={project.id}
            className={`${PROJECT_ROW_GRID} border-b py-3 text-sm last:border-b-0`}
          >
            <ProjectNameCell project={project} />
            <ProjectOrganizationCell project={project} organizations={organizations} />
            <div className="truncate text-xs">
              {hostname ? (
                <a
                  href={`https://${hostname}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  // Accessible name must not contain the slug: the specs locate
                  // THE project link by slug with a strict-mode locator.
                  aria-label="Project website"
                  className="text-blue-500 hover:underline"
                >
                  {hostname}
                </a>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </div>
            <ProjectStatusCell project={project} />
            <ProjectActionsCell project={project} recoverProject={recoverProject} />
          </div>
        );
      })}
    </div>
  );
}

function ProjectNameCell({ project }: { project: ProjectListEntry }) {
  return (
    <div className="min-w-0 space-y-0.5">
      {project.deploymentStatus === "ready" ? (
        <Link
          to="/projects/$projectSlug/agents/new"
          params={{ projectSlug: project.slug }}
          className="block truncate font-medium hover:underline"
        >
          {project.slug}
        </Link>
      ) : (
        <div className="truncate font-medium">{project.slug}</div>
      )}
      <Identifier value={project.id} textClassName="text-xs text-muted-foreground" />
    </div>
  );
}

function ProjectStatusCell({ project }: { project: ProjectListEntry }) {
  switch (project.deploymentStatus) {
    case "ready":
      return <Badge>Ready</Badge>;
    case "missing":
      return <Badge variant="secondary">Not set up in this deployment</Badge>;
    case "unknown":
      return <Badge variant="outline">Unknown</Badge>;
  }
}

function ProjectActionsCell({
  project,
  recoverProject,
}: {
  project: ProjectListEntry;
  recoverProject: UseMutationResult<unknown, Error, ProjectListEntry>;
}) {
  if (project.deploymentStatus === "missing") {
    const isPending = recoverProject.isPending && recoverProject.variables?.id === project.id;
    return (
      <div className="flex justify-end">
        <Button size="sm" onClick={() => recoverProject.mutate(project)} disabled={isPending}>
          {isPending ? "Setting up..." : "Set up"}
        </Button>
      </div>
    );
  }

  if (project.deploymentStatus === "ready") {
    return (
      <div className="flex justify-end gap-2">
        <Button
          nativeButton={false}
          type="button"
          variant="outline"
          size="sm"
          render={
            <Link to="/projects/$projectSlug/agents/new" params={{ projectSlug: project.slug }} />
          }
        >
          Open
        </Button>
      </div>
    );
  }

  return <div className="text-right text-xs text-muted-foreground">-</div>;
}

function ProjectOrganizationCell({
  project,
  organizations,
}: {
  project: ProjectListEntry;
  organizations: OrganizationSummary[];
}) {
  if (!project.organizationId) {
    return <div className="truncate text-xs text-muted-foreground">-</div>;
  }

  const organization = organizations.find((candidate) => candidate.id === project.organizationId);
  const organizationName = project.organizationName ?? organization?.name ?? organization?.slug;
  if (!organizationName) {
    return (
      <Identifier value={project.organizationId} textClassName="text-xs text-muted-foreground" />
    );
  }

  return (
    <div className="min-w-0">
      <div className="truncate text-xs">{organizationName}</div>
      <Identifier value={project.organizationId} textClassName="text-xs text-muted-foreground" />
    </div>
  );
}
