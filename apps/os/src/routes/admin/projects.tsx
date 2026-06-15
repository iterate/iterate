import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon, WaypointsIcon } from "lucide-react";
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

const PAGE_SIZE = 100;

export const Route = createFileRoute("/admin/projects")({
  component: AdminProjectsPage,
});

type AdminProject = {
  id: string;
  slug: string;
  customHostname: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function AdminProjectsPage() {
  const itx = useItx();
  const [pageIndex, setPageIndex] = useState(0);
  const offset = pageIndex * PAGE_SIZE;
  const projectsQuery = useQuery({
    queryKey: ["admin", "projects", { limit: PAGE_SIZE, offset }],
    queryFn: async () => await itx.projects.list({ limit: PAGE_SIZE, offset }),
  });
  const projects = (projectsQuery.data?.projects ?? []) as AdminProject[];
  const total = projectsQuery.data?.total ?? 0;
  const hasPrevious = pageIndex > 0;
  const hasNext = offset + projects.length < total;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            {projectsQuery.isPending ? "Loading projects..." : `${total.toLocaleString()} total`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasPrevious || projectsQuery.isFetching}
            onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
          >
            <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasNext || projectsQuery.isFetching}
            onClick={() => setPageIndex((current) => current + 1)}
          >
            Next
            <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
          </Button>
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
                <TableHead>Custom hostname</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
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
                    {project.customHostname ? (
                      <Badge variant="secondary">{project.customHostname}</Badge>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell>{formatDate(project.createdAt)}</TableCell>
                  <TableCell>{formatDate(project.updatedAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        nativeButton={false}
                        render={
                          <Link to="/admin/streams/$namespace" params={{ namespace: project.id }} />
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

function ProjectsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

function formatDate(value: string | null) {
  if (!value) return <span className="text-muted-foreground">-</span>;
  return <span className="text-muted-foreground">{new Date(value).toLocaleString()}</span>;
}
