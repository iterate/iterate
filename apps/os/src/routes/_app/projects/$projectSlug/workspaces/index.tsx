import { Link, createFileRoute } from "@tanstack/react-router";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { useItxQuery } from "iterate/sdk/itx/react";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

const WORKSPACES_ROOT = "/workspaces";

export const Route = createFileRoute("/_app/projects/$projectSlug/workspaces/")({
  staticData: streamPageStaticData(),
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, WORKSPACES_ROOT),
    }),
  component: ProjectWorkspacesIndexContent,
});

/** Every workspace of the project — agents' own, boards, scratch — from the platform catalog. */
function ProjectWorkspacesIndexContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const workspaces = useItxQuery({
    key: ["workspaces", project.id],
    query: (itx) => itx.workspaces.list(),
  });
  const rows = workspaces?.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));

  const panel = (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Workspaces</h2>
          <p className="text-xs text-muted-foreground">
            Each workspace is a private working copy of the project&rsquo;s path namespace: every
            repo mounted at its own /repos path, the workspace&rsquo;s own files beside them. Agents
            have one each.
          </p>
        </div>
        {rows === undefined ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-spinner="true">
            Loading workspaces…
          </div>
        ) : rows.length === 0 ? (
          <Empty className="rounded-lg border">
            <EmptyHeader>
              <EmptyTitle>No workspaces</EmptyTitle>
              <EmptyDescription>
                A workspace is born with each agent, or explicitly through itx.workspaces.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((workspace) => (
                  <TableRow key={workspace.path}>
                    <TableCell className="min-w-[16rem] py-3">
                      <Link
                        className="block min-w-0 truncate rounded-sm font-mono text-sm font-medium hover:underline"
                        to="/projects/$projectSlug/workspaces/$"
                        params={{
                          projectSlug: params.projectSlug,
                          _splat: workspace.path.slice(1),
                        }}
                        search={{}}
                      >
                        {workspace.path}
                      </Link>
                    </TableCell>
                    <TableCell className="w-40 text-muted-foreground">
                      {formatTimeAgo(workspace.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <ProjectStreamView
      layout="fullPanel"
      panel={panel}
      projectId={project.id}
      streamPath={WORKSPACES_ROOT}
      emptyLabel="No events on the workspaces catalogue stream yet."
    />
  );
}
