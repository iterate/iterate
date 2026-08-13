import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ExternalLinkIcon, PlusIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { useLiveState } from "iterate/sdk/itx/react";
import { CreateSandboxSheet } from "~/components/create-sandbox-sheet.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { SandboxStatusBadge } from "~/components/sandbox-status-badge.tsx";
import { buildCloudflareContainersDashboardUrl } from "~/lib/cloudflare-containers-dashboard-url.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

const SANDBOXES_ROOT = "/sandboxes";

export const Route = createFileRoute("/_app/projects/$projectSlug/sandboxes/")({
  staticData: streamPageStaticData(),
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: async ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      routeConfig: await getPublicRouteConfig(),
      streamBreadcrumb: streamBreadcrumb(context.project, SANDBOXES_ROOT),
    }),
  component: ProjectSandboxesIndexContent,
});

function ProjectSandboxesIndexContent() {
  const params = Route.useParams();
  const navigate = Route.useNavigate();
  const { project, routeConfig } = Route.useLoaderData();
  const [createOpen, setCreateOpen] = useState(false);
  const projectState = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced,
    [],
  ).value;
  const sandboxes = projectState?.streams
    .filter((stream) => /^\/sandboxes\/[^/]+$/.test(stream.path))
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const dashboardUrl = buildCloudflareContainersDashboardUrl({
    accountId: routeConfig.cloudflareAccountId,
  });

  const panel = (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <div className="flex flex-col justify-between gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">Sandboxes</h2>
            <p className="text-xs text-muted-foreground">
              Live container status, controls, and SSH instructions for each project sandbox.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              Create sandbox
            </Button>
            <Button
              variant="outline"
              size="sm"
              nativeButton={!dashboardUrl}
              disabled={!dashboardUrl}
              title={!dashboardUrl ? "Cloudflare account ID is not configured." : undefined}
              render={
                !dashboardUrl ? undefined : (
                  <a
                    href={dashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open the Cloudflare Containers dashboard"
                  />
                )
              }
            >
              <ExternalLinkIcon data-icon="inline-start" />
              Containers dashboard
            </Button>
          </div>
        </div>

        {!sandboxes ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-spinner="true">
            Loading sandboxes…
          </div>
        ) : !sandboxes.length ? (
          <Empty className="rounded-lg border">
            <EmptyHeader>
              <EmptyTitle>No sandboxes</EmptyTitle>
              <EmptyDescription>
                Create an isolated Linux container for this project.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <PlusIcon data-icon="inline-start" />
                Create sandbox
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sandbox</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Instance type</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sandboxes.map((sandbox) => (
                  <SandboxRow
                    key={sandbox.path}
                    createdAt={sandbox.createdAt}
                    path={sandbox.path}
                    projectSlug={params.projectSlug}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <CreateSandboxSheet
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(path) => {
            void navigate({
              to: "/projects/$projectSlug/sandboxes/$sandboxId",
              params: {
                projectSlug: params.projectSlug,
                sandboxId: path.slice(`${SANDBOXES_ROOT}/`.length),
              },
              search: {},
            });
          }}
        />
      </div>
    </div>
  );

  return (
    <ProjectStreamView
      layout="fullPanel"
      panel={panel}
      projectId={project.id}
      streamPath={SANDBOXES_ROOT}
      emptyLabel="No events on the sandboxes catalogue stream yet."
    />
  );
}

function SandboxRow({
  createdAt,
  path,
  projectSlug,
}: {
  createdAt: string;
  path: string;
  projectSlug: string;
}) {
  const sandboxState = useLiveState(
    (itx) => itx.sandboxes.get(path).liveState,
    (state) => state,
    [path],
  );
  const instanceType = sandboxState.value?.birthCertificate?.config.instanceType;

  return (
    <TableRow>
      <TableCell className="min-w-[16rem] py-3">
        <Link
          className="block min-w-0 truncate rounded-sm text-sm font-medium hover:underline"
          to="/projects/$projectSlug/sandboxes/$sandboxId"
          params={{ projectSlug, sandboxId: path.slice(`${SANDBOXES_ROOT}/`.length) }}
          search={{}}
        >
          {path}
        </Link>
      </TableCell>
      <TableCell className="w-32">
        <SandboxStatusBadge error={sandboxState.error} state={sandboxState.value} />
      </TableCell>
      <TableCell className="w-36 font-mono text-xs text-muted-foreground">
        {instanceType ?? "—"}
      </TableCell>
      <TableCell className="w-40 text-muted-foreground">{formatTimeAgo(createdAt)}</TableCell>
    </TableRow>
  );
}
