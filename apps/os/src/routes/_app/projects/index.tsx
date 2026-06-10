import { Suspense, useCallback, useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { toast } from "@iterate-com/ui/components/sonner";
import type { ItxProjects } from "~/itx/handle.ts";
import { useItx } from "~/itx/use-itx.ts";
import { getItxErrorCode } from "~/itx/errors.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";

type ProjectListItem = Awaited<ReturnType<ItxProjects["list"]>>["projects"][number];

export const Route = createFileRoute("/_app/projects/")({
  // The list paints from the itx socket (useItx), which never SSRs.
  ssr: false,
  loader: async () => ({ routeConfig: await getPublicRouteConfig() }),
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
  const [projects, setProjects] = useState<ProjectListItem[]>();
  const [deletingId, setDeletingId] = useState<string>();

  const loadProjects = useCallback(async () => {
    const result = await itx.projects.list({ limit: 20, offset: 0 });
    setProjects(result.projects);
  }, [itx]);

  useEffect(() => {
    loadProjects().catch((error) =>
      toast.error(error instanceof Error ? error.message : "Could not load projects."),
    );
  }, [loadProjects]);

  async function deleteProject(id: string) {
    setDeletingId(id);
    try {
      await itx.projects.remove({ id });
      await loadProjects();
    } catch (error) {
      toast.error(
        getItxErrorCode(error) === "FORBIDDEN"
          ? "Only operators can delete projects."
          : error instanceof Error
            ? error.message
            : "Could not delete the project.",
      );
    } finally {
      setDeletingId(undefined);
    }
  }

  if (projects === undefined) {
    return <div className="p-4 text-sm text-muted-foreground">Loading projects...</div>;
  }

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
                <Link
                  to="/projects/$projectSlug"
                  params={{
                    projectSlug: project.slug,
                  }}
                  className="truncate font-medium hover:underline"
                >
                  {project.slug}
                </Link>
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
                  onClick={() => void deleteProject(project.id)}
                  disabled={deletingId === project.id}
                >
                  {deletingId === project.id ? "Deleting..." : "Delete"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
