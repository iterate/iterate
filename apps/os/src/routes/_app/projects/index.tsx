import { Suspense, useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { toast } from "@iterate-com/ui/components/sonner";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { useItx } from "~/itx/use-itx.ts";
import type { ItxProjects } from "~/itx/handle.ts";

type ProjectSummary = Awaited<ReturnType<ItxProjects["list"]>>["projects"][number];

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
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectsIndexContent />
    </Suspense>
  );
}

function ProjectsIndexContent() {
  const { routeConfig } = Route.useLoaderData();
  const itx = useItx();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  async function refreshProjects() {
    try {
      const result = await itx.projects.list({ limit: 20, offset: 0 });
      setProjects(result.projects);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    let cancelled = false;
    itx.projects
      .list({ limit: 20, offset: 0 })
      .then((result) => {
        if (!cancelled) setProjects(result.projects);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the itx handle identity changes (reconnect), not on every dep churn
  }, [itx]);

  const deleteProject = useMutation({
    mutationFn: async (input: { id: string }) => {
      return await itx.projects.remove(input);
    },
    onSuccess: async () => {
      await refreshProjects();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const hasProjects = projects.length > 0;

  return (
    <section className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Projects</h2>
          <p className="text-sm text-muted-foreground">Create and manage projects.</p>
        </div>
        {hasProjects ? (
          <Button type="button" size="sm" render={<Link to="/new-project" />}>
            New project
          </Button>
        ) : null}
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
        <div className="overflow-x-auto rounded-lg border">
          <div className="grid min-w-[900px] grid-cols-[220px_160px_220px_minmax(220px,1fr)_190px_96px] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <div>ID</div>
            <div>Slug</div>
            <div>Custom hostname</div>
            <div>Hostname</div>
            <div>Created</div>
            <div />
          </div>
          {projects.map((project) => {
            const hostname = buildProjectHostname({
              slug: project.slug,
              customHostname: project.customHostname,
              projectHostnameBases: routeConfig.projectHostnameBases,
            });

            return (
              <div
                key={project.id}
                className="grid min-w-[900px] grid-cols-[220px_160px_220px_minmax(220px,1fr)_190px_96px] items-start gap-3 border-b px-3 py-3 text-sm last:border-b-0"
              >
                <Identifier value={project.id} textClassName="text-xs text-muted-foreground" />
                <ProjectSlugCell project={project} />
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
      )}
    </section>
  );
}

function ProjectSlugCell({ project }: { project: ProjectSummary }) {
  return (
    <Link
      to="/projects/$projectSlug"
      params={{
        projectSlug: project.slug,
      }}
      className="truncate font-medium hover:underline"
    >
      {project.slug}
    </Link>
  );
}
