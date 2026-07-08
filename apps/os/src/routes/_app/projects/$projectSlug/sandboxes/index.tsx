import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Copy, ExternalLink, SquareTerminal } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { StreamTree } from "~/components/stream-tree.tsx";
import {
  buildCloudflareContainersDashboardUrl,
  inferOsDopplerConfigForWorkerName,
} from "~/lib/cloudflare-containers-dashboard-url.ts";
import { getPublicRouteConfig, type PublicRouteConfig } from "~/lib/public-route-config.ts";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItx } from "~/itx/itx-react.tsx";

const SANDBOXES_ROOT = "/sandboxes";

export const Route = createFileRoute("/_app/projects/$projectSlug/sandboxes/")({
  // Sandboxes ARE streams (a sandbox lives at /sandboxes/<name>):
  // this page is the /sandboxes catalogue stream's view, with the live
  // sandbox tree in the side panel.
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: async ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      routeConfig: await getPublicRouteConfig(),
      streamBreadcrumb: streamBreadcrumb(context.project, SANDBOXES_ROOT),
    }),
  component: ProjectSandboxesIndexPage,
});

function ProjectSandboxesIndexPage() {
  return (
    <ItxBoundary>
      <ProjectSandboxesIndexContent />
    </ItxBoundary>
  );
}

function ProjectSandboxesIndexContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project, routeConfig } = Route.useLoaderData();
  const itx = useItx();
  const source = useMemo(() => (streamPath: string) => itx.streams.get(streamPath), [itx]);

  return (
    <ProjectStreamView
      panel={
        <>
          <SandboxOperationsPanel routeConfig={routeConfig} />

          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Sandbox streams</h2>
              <p className="text-xs text-muted-foreground">
                Sandboxes are created explicitly and addressed as{" "}
                <code className="font-mono">/sandboxes/&lt;name&gt;</code>.
              </p>
            </div>
            <StreamTree
              source={source}
              rootPath={SANDBOXES_ROOT}
              scope={project.id}
              onOpenPath={(streamPath) =>
                void navigate(linkOptionsForStreamPath(params.projectSlug, streamPath))
              }
            />
          </div>
        </>
      }
      projectId={project.id}
      streamPath={SANDBOXES_ROOT}
      emptyLabel="No events on the sandboxes catalogue stream yet."
    />
  );
}

function SandboxOperationsPanel({ routeConfig }: { routeConfig: PublicRouteConfig }) {
  const dashboardUrl = buildCloudflareContainersDashboardUrl({
    accountId: routeConfig.cloudflareAccountId,
  });
  // Resolve the fallback ONCE so the displayed worker name and the copied
  // commands can't disagree (a missing name shows `os` and infers `dev`).
  const workerName = routeConfig.cloudflareWorkerName ?? "os";
  const dopplerConfig = inferOsDopplerConfigForWorkerName(workerName);
  const listInstancesCommand = [
    "cd apps/os",
    `doppler run --config ${dopplerConfig} --project os -- pnpm exec wrangler containers list`,
    `doppler run --config ${dopplerConfig} --project os -- pnpm exec wrangler containers instances <APPLICATION_ID>`,
  ].join("\n");
  const wranglerSshCommand = [
    "cd apps/os",
    `doppler run --config ${dopplerConfig} --project os -- pnpm exec wrangler containers ssh <INSTANCE_ID>`,
  ].join("\n");
  const proxySshCommand = [
    "cd apps/os",
    `ssh -o ProxyCommand="doppler run --config ${dopplerConfig} --project os -- pnpm exec wrangler containers ssh %h" cloudchamber@<INSTANCE_ID>`,
  ].join("\n");

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <SquareTerminal className="size-4 text-muted-foreground" />
            Sandbox operations
          </h2>
          <p className="text-xs text-muted-foreground">
            SSH is available for running instances whose container class has your public key.
          </p>
        </div>
        {dashboardUrl ? (
          <Button
            variant="outline"
            size="sm"
            render={
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Open Cloudflare Containers dashboard"
              />
            }
          >
            <ExternalLink data-icon="inline-start" />
            Dashboard
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            title="Cloudflare account ID is not configured."
          >
            <ExternalLink data-icon="inline-start" />
            Dashboard
          </Button>
        )}
      </div>

      <dl className="grid gap-2 text-xs">
        <MetadataLine label="Worker" value={workerName} />
        <MetadataLine
          label="Container classes"
          value="Sandbox<Type>DurableObject (one per instance type)"
        />
        <MetadataLine label="Doppler config" value={dopplerConfig} />
      </dl>

      <CommandBlock label="Find a running instance" value={listInstancesCommand} />
      <CommandBlock label="Open a shell with Wrangler" value={wranglerSshCommand} />
      <CommandBlock label="Use OpenSSH or scp" value={proxySshCommand} />
    </div>
  );
}

function MetadataLine(input: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{input.label}</dt>
      <dd className="min-w-0 break-all font-mono text-foreground">{input.value}</dd>
    </div>
  );
}

function CommandBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => toast.success("Copied"),
              () => toast.error("Could not copy"),
            );
          }}
        >
          <Copy />
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-5 text-foreground">
        <code>{value}</code>
      </pre>
    </div>
  );
}
