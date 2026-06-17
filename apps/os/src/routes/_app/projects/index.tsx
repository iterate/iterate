import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { useAuthClient } from "@iterate-com/auth/client";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { toast } from "@iterate-com/ui/components/sonner";
import type { ReactNode } from "react";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import {
  createProjectServerFn,
  deleteProjectServerFn,
  listMyProjectsServerFn,
  myProjectsListInput,
  myProjectsQueryKey,
  myProjectsStaleTime,
  type Project,
} from "~/lib/project-server-fns.ts";
import { reconnectItx } from "~/itx/itx-react.tsx";

type OrganizationSummary = {
  id: string;
  name?: string | null;
  slug: string;
};

export const Route = createFileRoute("/_app/projects/")({
  ssr: false,
  loader: async () => ({
    routeConfig: await getPublicRouteConfig(),
  }),
  component: ProjectsIndexPage,
});

function buildProjectHostname(input: {
  slug: string;
  customHostname: string | null;
  projectHostnameBases: readonly string[];
}) {
  if (input.customHostname) return input.customHostname;
  const base = input.projectHostnameBases[0];
  if (!base) return null;
  return `${input.slug}.${normalizeProjectHostnameBase(base)}`;
}

function ProjectsIndexPage() {
  const { routeConfig } = Route.useLoaderData();
  const { session } = useAuthClient();
  const organizations = session?.authenticated ? session.session.organizations : [];
  const isAdmin = session?.authenticated ? session.user.isAdmin === true : false;
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: myProjectsQueryKey,
    queryFn: () => listMyProjectsServerFn({ data: myProjectsListInput }),
    staleTime: myProjectsStaleTime,
  });
  const projects = list.data?.projects ?? [];

  // The scoped oRPC list intentionally merges two sources:
  // - OS D1 rows for projects that exist in this deployment.
  // - Auth-session project claims when auth still knows about a project but this
  //   OS worker database does not. That happens in preview/dev when we delete or
  //   recreate the OS database but leave the auth worker database intact. Showing
  //   those auth-only rows separately lets us recover the exact auth-owned
  //   project IDs and slugs without inventing random fallback slugs.
  const osProjects = projects.filter((project) => !project.isOrphanedProjectFromAuthService);
  const recoveredProjects = projects.filter((project) => project.isOrphanedProjectFromAuthService);
  const hasProjects = osProjects.length > 0 || recoveredProjects.length > 0;

  const deleteProject = useMutation({
    mutationFn: async (input: { id: string }) => {
      return await deleteProjectServerFn({ data: input });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myProjectsQueryKey });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const recoverProject = useMutation({
    mutationFn: async (project: Project) => {
      const organizationSlug = project.organizationId
        ? organizations.find((organization) => organization.id === project.organizationId)?.slug
        : undefined;
      return await createProjectServerFn({
        data: {
          id: project.id,
          slug: project.slug,
          organizationSlug,
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myProjectsQueryKey });
      reconnectItx();
      toast.success("Project recovered");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  return (
    <section className="space-y-5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Projects</h2>
          <p className="text-sm text-muted-foreground">
            Create and manage projects in this OS deployment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              render={<Link to="/admin/projects" />}
            >
              Go to admin project list
            </Button>
          ) : null}
          {hasProjects ? (
            <Button type="button" size="sm" render={<Link to="/new-project" />}>
              New project
            </Button>
          ) : null}
        </div>
      </div>

      {!hasProjects ? (
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
            <Button type="button" size="sm" render={<Link to="/new-project" />}>
              Create new project
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ProjectTableSection
            title="Projects in this OS deployment"
            description="These projects exist in this OS worker database and are present in your auth session."
          >
            {osProjects.length === 0 ? (
              <EmptyTableMessage>
                No OS-backed projects are available in this deployment.
              </EmptyTableMessage>
            ) : (
              <OsProjectsTable
                projects={osProjects}
                organizations={organizations}
                projectHostnameBases={routeConfig.projectHostnameBases}
                deleteProject={deleteProject}
              />
            )}
          </ProjectTableSection>

          <ProjectTableSection
            title="Recovered from auth session"
            description="These projects are present in your auth session but do not exist in this OS worker deployment."
          >
            {recoveredProjects.length === 0 ? (
              <EmptyTableMessage>No auth-only projects need recovery.</EmptyTableMessage>
            ) : (
              <RecoveredProjectsTable
                projects={recoveredProjects}
                organizations={organizations}
                recoverProject={recoverProject}
              />
            )}
          </ProjectTableSection>
        </>
      )}
    </section>
  );
}

function ProjectTableSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="space-y-2">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function EmptyTableMessage({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function OsProjectsTable({
  deleteProject,
  organizations,
  projectHostnameBases,
  projects,
}: {
  deleteProject: UseMutationResult<unknown, Error, { id: string }>;
  organizations: OrganizationSummary[];
  projectHostnameBases: readonly string[];
  projects: Project[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <div className="grid min-w-[1040px] grid-cols-[220px_160px_220px_180px_minmax(220px,1fr)_190px_96px] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <div>ID</div>
        <div>Slug</div>
        <div>Organization</div>
        <div>Custom hostname</div>
        <div>Hostname</div>
        <div>Created</div>
        <div />
      </div>
      {projects.map((project) => {
        const hostname = buildProjectHostname({
          slug: project.slug,
          customHostname: project.customHostname,
          projectHostnameBases,
        });

        return (
          <div
            key={project.id}
            className="grid min-w-[1040px] grid-cols-[220px_160px_220px_180px_minmax(220px,1fr)_190px_96px] items-start gap-3 border-b px-3 py-3 text-sm last:border-b-0"
          >
            <Identifier value={project.id} textClassName="text-xs text-muted-foreground" />
            <ProjectSlugCell project={project} />
            <ProjectOrganizationCell project={project} organizations={organizations} />
            <div className="truncate text-xs text-muted-foreground">
              {project.customHostname ?? "None"}
            </div>
            <div className="truncate text-xs">
              {hostname ? (
                <a
                  href={`https://${hostname}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  {hostname}
                </a>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">{project.createdAt ?? "-"}</div>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteProject.mutate({ id: project.id })}
              disabled={deleteProject.isPending && deleteProject.variables?.id === project.id}
            >
              {deleteProject.isPending && deleteProject.variables?.id === project.id
                ? "Deleting..."
                : "Delete"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function RecoveredProjectsTable({
  organizations,
  projects,
  recoverProject,
}: {
  organizations: OrganizationSummary[];
  projects: Project[];
  recoverProject: UseMutationResult<unknown, Error, Project>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <div className="grid min-w-[820px] grid-cols-[220px_180px_240px_minmax(160px,1fr)_120px] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <div>ID</div>
        <div>Slug</div>
        <div>Organization</div>
        <div>Status</div>
        <div />
      </div>
      {projects.map((project) => (
        <div
          key={project.id}
          className="grid min-w-[820px] grid-cols-[220px_180px_240px_minmax(160px,1fr)_120px] items-start gap-3 border-b px-3 py-3 text-sm last:border-b-0"
        >
          <Identifier value={project.id} textClassName="text-xs text-muted-foreground" />
          <div className="truncate font-medium">{project.slug}</div>
          <ProjectOrganizationCell project={project} organizations={organizations} />
          <div className="text-xs text-muted-foreground">
            Auth session only; missing from this OS worker database.
          </div>
          <Button
            size="sm"
            onClick={() => recoverProject.mutate(project)}
            disabled={recoverProject.isPending && recoverProject.variables?.id === project.id}
          >
            {recoverProject.isPending && recoverProject.variables?.id === project.id
              ? "Recovering..."
              : "Recover"}
          </Button>
        </div>
      ))}
    </div>
  );
}

function ProjectOrganizationCell({
  project,
  organizations,
}: {
  project: Project;
  organizations: OrganizationSummary[];
}) {
  if (!project.organizationId) {
    return <div className="truncate text-xs text-muted-foreground">-</div>;
  }

  const organization = organizations.find((candidate) => candidate.id === project.organizationId);
  return (
    <div className="min-w-0">
      <div className="truncate text-xs">
        {organization?.name ?? organization?.slug ?? project.organizationId}
      </div>
      <div className="truncate text-xs text-muted-foreground">{project.organizationId}</div>
    </div>
  );
}

function ProjectSlugCell({ project }: { project: Project }) {
  return (
    <Link
      to="/projects/$projectSlug/agents/new"
      params={{
        projectSlug: project.slug,
      }}
      className="truncate font-medium hover:underline"
    >
      {project.slug}
    </Link>
  );
}
