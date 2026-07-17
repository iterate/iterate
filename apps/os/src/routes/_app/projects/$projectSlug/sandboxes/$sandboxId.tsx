import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CircleStopIcon,
  CopyIcon,
  ExternalLinkIcon,
  MoonIcon,
  PlayIcon,
  RotateCwIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@iterate-com/ui/components/alert-dialog";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { useItx, useLiveState } from "iterate/react";
import { InfoRow } from "~/components/info-row.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { SandboxStatusBadge } from "~/components/sandbox-status-badge.tsx";
import { DurableObjectNameCodec } from "~/domains/durable-object-names.ts";
import { SANDBOX_INSTANCE_TYPE_BINDINGS } from "~/domains/sandboxes/instance-types.ts";
import type { SandboxProcessorState } from "~/domains/sandboxes/sandbox-processor-contract.ts";
import {
  buildCloudflareContainersDashboardUrl,
  inferOsDopplerConfigForWorkerName,
} from "~/lib/cloudflare-containers-dashboard-url.ts";
import { getCloudflareContainerDashboardTarget } from "~/lib/cloudflare-container-dashboard-target.ts";
import { getPublicRouteConfig, type PublicRouteConfig } from "~/lib/public-route-config.ts";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

type SandboxAction = "start" | "stop" | "restart" | "kill" | "destroy";

export const Route = createFileRoute("/_app/projects/$projectSlug/sandboxes/$sandboxId")({
  staticData: streamPageStaticData(),
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: async ({ context, params }) => {
    const sandboxPath = `/sandboxes/${params.sandboxId}`;
    return breadcrumbLoaderData({
      project: context.project,
      routeConfig: await getPublicRouteConfig(),
      streamBreadcrumb: streamBreadcrumb(context.project, sandboxPath),
    });
  },
  component: ProjectSandboxDetailContent,
});

function ProjectSandboxDetailContent() {
  const params = Route.useParams();
  const { project, routeConfig } = Route.useLoaderData();
  const sandboxPath = `/sandboxes/${params.sandboxId}`;
  const sandboxState = useLiveState(
    (itx) => itx.sandboxes.liveState(sandboxPath),
    (state) => state,
    [sandboxPath],
  );

  // ProjectStreamView opens the addressed stream. Wait until the catalogue-
  // guarded live-state lookup proves this sandbox exists so a typed typo can
  // never materialize a phantom /sandboxes/<name> stream.
  if (sandboxState.value === undefined) {
    return (
      <div
        className="rounded-lg border p-4 text-sm text-muted-foreground"
        data-spinner={sandboxState.error === undefined ? "true" : undefined}
      >
        {sandboxState.error ?? "Loading sandbox…"}
      </div>
    );
  }

  const panel = (
    <SandboxDetailPanel
      projectId={project.id}
      routeConfig={routeConfig}
      sandboxPath={sandboxPath}
      state={sandboxState.value}
    />
  );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={project.id}
      streamPath={sandboxPath}
      emptyLabel="No events on this sandbox's stream yet."
    />
  );
}

function SandboxDetailPanel({
  projectId,
  routeConfig,
  sandboxPath,
  state,
}: {
  projectId: string;
  routeConfig: PublicRouteConfig;
  sandboxPath: string;
  state: SandboxProcessorState;
}) {
  const itx = useItx();
  const [destroyOpen, setDestroyOpen] = useState(false);
  const destroyed = state.status === "destroyed";
  const action = useMutation({
    mutationFn: async (requested: SandboxAction) => {
      const sandbox = await itx.sandboxes.get(sandboxPath);
      if (requested === "start") await sandbox.start();
      if (requested === "stop") await sandbox.sleep();
      if (requested === "restart") await sandbox.restart();
      if (requested === "destroy") await sandbox.destroy();
      if (requested === "kill") {
        try {
          await sandbox.kill();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.toLowerCase().includes("kill requested")) throw error;
        }
      }
      return requested;
    },
    onSuccess: (requested) => {
      if (requested === "destroy") setDestroyOpen(false);
      toast.success(sandboxActionSuccess(requested));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
  const pending = (requested: SandboxAction) => action.isPending && action.variables === requested;

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-3 border-b p-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">{sandboxPath}</h2>
              <p className="text-xs text-muted-foreground">Reduced sandbox lifecycle state</p>
            </div>
            <SandboxStatusBadge state={state} />
          </div>
          <InfoRow
            label="Instance type"
            value={state.birthCertificate?.config.instanceType ?? "unknown"}
          />
          <InfoRow label="Lifecycle" value={state.status ?? "unknown"} />
          <InfoRow label="Running" value={state.running ? "yes" : "no"} />
          <InfoRow label="Latest backup" value={state.lastBackupId ?? "none"} />
        </div>

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">Controls</h2>
            <p className="text-xs text-muted-foreground">
              Stop and restart preserve <code className="font-mono">/workspace</code> through a
              snapshot. Destroy permanently retires this sandbox name.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={action.isPending || destroyed || state.running}
              onClick={() => action.mutate("start")}
            >
              {pending("start") ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              Start
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending || destroyed || !state.running}
              onClick={() => action.mutate("stop")}
            >
              {pending("stop") ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <MoonIcon data-icon="inline-start" />
              )}
              Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending || destroyed || !state.running}
              onClick={() => action.mutate("restart")}
            >
              {pending("restart") ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RotateCwIcon data-icon="inline-start" />
              )}
              Restart
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={action.isPending || destroyed}
              title="Abort the Durable Object incarnation; its container lifecycle is unchanged."
              onClick={() => action.mutate("kill")}
            >
              {pending("kill") ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CircleStopIcon data-icon="inline-start" />
              )}
              Kill object
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={action.isPending || destroyed}
              onClick={() => setDestroyOpen(true)}
            >
              <Trash2Icon data-icon="inline-start" />
              Destroy
            </Button>
          </div>
        </div>

        <SandboxSshInstructions
          projectId={projectId}
          routeConfig={routeConfig}
          sandboxPath={sandboxPath}
          state={state}
        />
      </div>

      <AlertDialog open={destroyOpen} onOpenChange={setDestroyOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Destroy {sandboxPath}?</AlertDialogTitle>
            <AlertDialogDescription>
              This tears down the container without another snapshot and permanently retires the
              name. Existing backups expire on their normal retention schedule.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={action.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={action.isPending}
              onClick={() => action.mutate("destroy")}
            >
              {pending("destroy") ? <Spinner data-icon="inline-start" /> : null}
              Destroy sandbox
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SandboxSshInstructions({
  projectId,
  routeConfig,
  sandboxPath,
  state,
}: {
  projectId: string;
  routeConfig: PublicRouteConfig;
  sandboxPath: string;
  state: SandboxProcessorState;
}) {
  const instanceType = state.birthCertificate?.config.instanceType;
  const containerClass =
    instanceType === undefined
      ? "Sandbox<Type>DurableObject"
      : SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].className;
  const durableObjectName = DurableObjectNameCodec.stringify({ path: sandboxPath, projectId });
  const workerName = routeConfig.cloudflareWorkerName ?? "os";
  const dopplerConfig = inferOsDopplerConfigForWorkerName(workerName);
  const dashboardTargetQuery = useQuery({
    queryKey: ["cloudflare-container-dashboard-target", projectId, sandboxPath, instanceType],
    queryFn: () =>
      instanceType === undefined
        ? null
        : getCloudflareContainerDashboardTarget({
            data: { instanceType, projectId, sandboxPath },
          }),
    enabled: instanceType !== undefined,
    retry: 1,
    staleTime: Infinity,
  });
  const dashboardTarget = dashboardTargetQuery.data;
  const containersDashboardUrl = buildCloudflareContainersDashboardUrl({
    accountId: routeConfig.cloudflareAccountId,
  });
  const exactDashboardUrl = dashboardTarget
    ? buildCloudflareContainersDashboardUrl({
        accountId: routeConfig.cloudflareAccountId,
        ...dashboardTarget,
      })
    : null;
  const dashboardUrl =
    exactDashboardUrl ??
    (instanceType === undefined || dashboardTarget === null ? containersDashboardUrl : null);
  let dashboardTitle: string | undefined;
  if (instanceType !== undefined && dashboardTargetQuery.isPending) {
    dashboardTitle = "Resolving this sandbox's Cloudflare container page…";
  } else if (dashboardTargetQuery.error instanceof Error) {
    dashboardTitle = dashboardTargetQuery.error.message;
  } else if (dashboardUrl === null) {
    dashboardTitle = "Cloudflare container dashboard details are not configured.";
  } else if (dashboardTarget === null) {
    dashboardTitle = "This local environment has no deployed Cloudflare container application.";
  }
  const commandPrefix = `doppler run --config ${dopplerConfig} --project os -- pnpm exec wrangler`;
  const applicationId = dashboardTarget?.applicationId ?? "<APPLICATION_ID>";
  const instanceId = dashboardTarget?.instanceId ?? "<INSTANCE_ID>";
  const findInstance = [
    "cd apps/os",
    ...(dashboardTarget ? [] : [`${commandPrefix} containers list`]),
    `${commandPrefix} containers instances ${applicationId} --json | jq -r --arg name '${durableObjectName.replaceAll("'", `'\\''`)}' '.[] | select(.name == $name)'`,
  ].join("\n");
  const wranglerSsh = ["cd apps/os", `${commandPrefix} containers ssh ${instanceId}`].join("\n");
  const openSsh = [
    "cd apps/os",
    `ssh -o ProxyCommand="${commandPrefix} containers ssh %h" cloudchamber@${instanceId}`,
  ].join("\n");

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <SquareTerminalIcon className="size-4 text-muted-foreground" />
            SSH into this sandbox
          </h2>
          <p className="text-xs text-muted-foreground">
            SSH only works while the reduced state says Running. Start the sandbox first if it is
            stopped.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          nativeButton={dashboardUrl === null}
          disabled={dashboardUrl === null}
          title={dashboardTitle}
          render={
            dashboardUrl === null ? undefined : (
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Open this sandbox's Cloudflare container page"
              />
            )
          }
        >
          <ExternalLinkIcon data-icon="inline-start" />
          {dashboardTarget === null ? "Containers" : "Container page"}
        </Button>
      </div>

      <dl className="grid gap-2 text-xs">
        <MetadataLine label="Container class" value={containerClass} />
        <MetadataLine label="Instance row name" value={durableObjectName} />
        <MetadataLine label="Application ID" value={applicationId} />
        <MetadataLine label="Container instance ID" value={instanceId} />
        <MetadataLine label="Worker" value={workerName} />
        <MetadataLine label="Doppler config" value={dopplerConfig} />
      </dl>

      <p className="text-xs text-muted-foreground">
        {dashboardTarget ? (
          <>The Cloudflare application and container instance IDs above are resolved directly.</>
        ) : (
          <>
            In the first command, choose the application for <code>{containerClass}</code>, then
            copy the <code>id</code> from the row whose <code>name</code> matches this sandbox.
          </>
        )}
      </p>
      <CommandBlock label="Inspect this running instance" value={findInstance} />
      <CommandBlock label="Open a shell with Wrangler" value={wranglerSsh} />
      <CommandBlock label="Use OpenSSH or scp" value={openSsh} />
    </div>
  );
}

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-foreground">{value}</dd>
    </div>
  );
}

function CommandBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2">
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
          <CopyIcon />
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-5 text-foreground">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function sandboxActionSuccess(action: SandboxAction) {
  if (action === "start") return "Sandbox started";
  if (action === "stop") return "Sandbox stopped";
  if (action === "restart") return "Sandbox restarted";
  if (action === "kill") return "Sandbox object killed";
  return "Sandbox destroyed";
}
