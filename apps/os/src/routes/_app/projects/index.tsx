import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { useAuthClient } from "@iterate-com/auth/client";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { toast } from "@iterate-com/ui/components/sonner";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import {
  createMyProjectServerFn,
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
  const hasProjects = projects.length > 0;

  const deleteProject = useMutation({
    mutationFn: async (input: { id: string }) => {
      return await deleteProjectServerFn({ data: input });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myProjectsQueryKey });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  // "Set up" for a project the auth worker knows about but this deployment's
  // engine does not: re-run the create with the claim's exact id and slug. The
  // auth side is idempotent (createForOrganization returns the existing row),
  // then the engine bootstrap saga runs.
  const recoverProject = useMutation({
    mutationFn: async (project: Project) => {
      const organizationSlug = project.organizationId
        ? organizations.find((organization) => organization.id === project.organizationId)?.slug
        : undefined;
      return await createMyProjectServerFn({
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
      toast.success("Project set up");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

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
          deleteProject={deleteProject}
          recoverProject={recoverProject}
        />
      )}
    </section>
  );
}

const PROJECT_ROW_GRID =
  "grid min-w-[980px] grid-cols-[240px_220px_minmax(220px,1fr)_220px_200px] items-start gap-3 px-3";

function ProjectsTable({
  deleteProject,
  organizations,
  projectHostnameBases,
  projects,
  recoverProject,
}: {
  deleteProject: UseMutationResult<unknown, Error, { id: string }>;
  organizations: OrganizationSummary[];
  projectHostnameBases: readonly string[];
  projects: Project[];
  recoverProject: UseMutationResult<unknown, Error, Project>;
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
          customHostname: project.customHostname,
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
                  className="text-blue-500 hover:underline"
                >
                  {hostname}
                </a>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </div>
            <ProjectStatusCell project={project} />
            <ProjectActionsCell
              project={project}
              deleteProject={deleteProject}
              recoverProject={recoverProject}
            />
          </div>
        );
      })}
    </div>
  );
}

function ProjectNameCell({ project }: { project: Project }) {
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

function ProjectStatusCell({ project }: { project: Project }) {
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
  deleteProject,
  project,
  recoverProject,
}: {
  deleteProject: UseMutationResult<unknown, Error, { id: string }>;
  project: Project;
  recoverProject: UseMutationResult<unknown, Error, Project>;
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
    const isDeleting = deleteProject.isPending && deleteProject.variables?.id === project.id;
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
        <Button
          size="sm"
          variant="destructive"
          onClick={() => deleteProject.mutate({ id: project.id })}
          disabled={isDeleting}
        >
          {isDeleting ? "Deleting..." : "Delete"}
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
  project: Project;
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
