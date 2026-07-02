import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLinkIcon, WaypointsIcon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Skeleton } from "@iterate-com/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { useItx } from "~/itx/itx-react.tsx";
import type { ProjectListEntry } from "~/types.ts";

export const Route = createFileRoute("/admin/projects")({
  component: AdminProjectsPage,
});

function AdminProjectsPage() {
  // This renders under the admin layout's AdminGate, so the global itx handle
  // carries admin authority: `projects.list()` returns every deployment-known
  // project (from the project directory), each with its engine status.
  const itx = useItx();
  const projectsQuery = useQuery({
    // NOT the shared ["itx", "projects"] entry: the admin list is the
    // deployment-wide view, the user list is claims-scoped — same socket,
    // different results.
    queryKey: ["itx", "admin-projects"],
    queryFn: async () => await itx.projects.list(),
  });
  const projects = projectsQuery.data ?? [];

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            {projectsQuery.isPending
              ? "Loading projects..."
              : `${projects.length.toLocaleString()} total`}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {projectsQuery.isPending ? (
          <ProjectsSkeleton />
        ) : projectsQuery.isError ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Could not load projects</EmptyTitle>
              <EmptyDescription>
                {projectsQuery.error instanceof Error
                  ? projectsQuery.error.message
                  : "The project list could not be read."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : projects.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No projects</EmptyTitle>
              <EmptyDescription>No projects exist in this environment.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <TableRow key={project.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/projects/$projectSlug"
                      params={{ projectSlug: project.slug }}
                      className="hover:underline"
                    >
                      {project.slug}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {project.id}
                  </TableCell>
                  <TableCell>
                    {project.organizationName ?? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {project.organizationId ?? "-"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ProjectStatusBadge project={project} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        nativeButton={false}
                        render={
                          <Link to="/admin/streams/$projectId" params={{ projectId: project.id }} />
                        }
                      >
                        <WaypointsIcon data-icon="inline-start" aria-hidden="true" />
                        Streams
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        nativeButton={false}
                        aria-label={`Open ${project.slug}`}
                        render={
                          <Link
                            to="/projects/$projectSlug"
                            params={{ projectSlug: project.slug }}
                          />
                        }
                      >
                        <ExternalLinkIcon aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function ProjectStatusBadge({ project }: { project: ProjectListEntry }) {
  switch (project.deploymentStatus) {
    case "ready":
      return <Badge>Ready</Badge>;
    case "missing":
      return <Badge variant="secondary">Not set up in this deployment</Badge>;
    case "unknown":
      return <Badge variant="outline">Unknown</Badge>;
  }
}

function ProjectsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}
