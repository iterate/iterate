import { useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Globe,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.tsx";
import { DaemonStatus } from "../../components/daemon-status.tsx";
import { SerializedObjectCodeBlock } from "../../components/serialized-object-code-block.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { TypeId } from "../../components/type-id.tsx";

export const Route = createFileRoute("/_auth/proj/$projectSlug/machines/$machineId")({
  component: MachineDetailPage,
});

/** Pidnap-managed processes — mirrors sandbox/pidnap.config.ts */
const PIDNAP_PROCESSES = [
  "daemon-backend",
  "daemon-frontend",
  "opencode",
  "egress-proxy",
  "trace-viewer",
] as const;

function parseFlyExternalId(externalId: string): { appName: string; machineId: string } | null {
  const separatorIndex = externalId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === externalId.length - 1) return null;
  const appName = externalId.slice(0, separatorIndex);
  const machineId = externalId.slice(separatorIndex + 1);
  return { appName, machineId };
}

type MachineMetadata = {
  host?: string;
  port?: number;
  ports?: Record<string, number>;
  containerId?: string;
  containerName?: string;
  snapshotName?: string;
  sandboxName?: string;
  daemonStatus?: "ready" | "error" | "restarting" | "stopping" | "verifying" | "retrying";
  daemonReadyAt?: string;
  daemonStatusMessage?: string;
  provisioningError?: string;
} & Record<string, unknown>;

function MachineDetailPage() {
  const params = useParams({ from: "/_auth/proj/$projectSlug/machines/$machineId" });
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const machineQueryKey = trpc.machine.byId.queryKey({
    projectSlug: params.projectSlug,
    machineId: params.machineId,
  });

  const machineListQueryKey = trpc.machine.list.queryKey({
    projectSlug: params.projectSlug,
    includeArchived: false,
  });

  const { data: machine } = useSuspenseQuery(
    trpc.machine.byId.queryOptions({
      projectSlug: params.projectSlug,
      machineId: params.machineId,
    }),
  );

  const metadata = machine.metadata as MachineMetadata;
  const { services } = machine;

  const restartMachine = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.restart.mutate({
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine restarting");
      queryClient.invalidateQueries({ queryKey: machineQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to restart: " + error.message);
    },
  });

  const restartDaemon = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.restartDaemon.mutate({
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
    },
    onSuccess: () => {
      toast.success("Daemon restarting");
      queryClient.invalidateQueries({ queryKey: machineQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to restart daemon: " + error.message);
    },
  });

  const deleteMachine = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.delete.mutate({
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine deleted");
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
      navigate({ to: "/proj/$projectSlug/machines", params: { projectSlug: params.projectSlug } });
    },
    onError: (error) => {
      toast.error("Failed to delete: " + error.message);
    },
  });

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied: ${text}`);
  };

  const { data: agentsData, isLoading: agentsLoading } = useQuery(
    trpc.machine.listAgents.queryOptions(
      {
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      },
      {
        enabled: machine.state === "active" && metadata.daemonStatus === "ready",
        refetchInterval: 10000,
      },
    ),
  );

  const agents = [...(agentsData?.agents ?? [])].sort(
    (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
  );

  const iterateDaemonService = services.find((service) => service.id === "iterate-daemon");
  const daemonBaseUrl = iterateDaemonService?.options[0]?.url;
  const opencodeService = services.find((service) => service.id === "opencode");
  const opencodeBaseUrl = opencodeService?.options[0]?.url;

  const flyMachine = machine.type === "fly" ? parseFlyExternalId(machine.externalId) : null;
  const flyMachineUrl = flyMachine
    ? `https://fly.io/apps/${flyMachine.appName}/machines/${flyMachine.machineId}`
    : null;
  const flyGrafanaOrgId = import.meta.env.VITE_FLY_GRAFANA_ORG_ID ?? "1440139";
  const flyGrafanaUrl = flyMachine
    ? `https://fly-metrics.net/d/fly-app/fly-app?${new URLSearchParams({
        orgId: flyGrafanaOrgId,
        "var-app": flyMachine.appName,
      }).toString()}`
    : null;
  const flyLogsUrl = flyMachine ? `https://fly.io/apps/${flyMachine.appName}/monitoring` : null;
  const flyNetworkingUrl = flyMachine
    ? `https://fly.io/apps/${flyMachine.appName}/networking`
    : null;

  const buildTerminalUrl = (command: string) => {
    if (!daemonBaseUrl) return "#";
    return `${daemonBaseUrl}/terminal?${new URLSearchParams({ command, autorun: "true" })}`;
  };

  const getServiceAccessLabel = (option: { label: string; url: string }) => {
    if (option.label === "Open" && option.url.startsWith("/")) return "Proxy";
    return option.label;
  };

  const extractSessionId = (destination?: string | null) => {
    if (!destination) return null;
    const match = destination.match(/^\/opencode\/sessions\/(.+)$/);
    return match?.[1] ?? null;
  };

  const getAgentAttachCommand = (destination?: string | null, workingDirectory?: string | null) => {
    const sessionId = extractSessionId(destination);
    if (!sessionId) return null;
    const cmd = `opencode attach 'http://localhost:4096' --session ${sessionId}`;
    return workingDirectory ? `${cmd} --dir ${workingDirectory}` : cmd;
  };

  /** Build OpenCode web UI deep link: {base}/{base64(dir)}/session/{id} */
  const buildOpencodeWebUrl = (
    sessionId: string | null,
    workingDirectory?: string | null,
  ): string | null => {
    if (!sessionId || !opencodeBaseUrl || !workingDirectory) return null;
    const encodedDir = btoa(workingDirectory).replace(/=+$/, "");
    return `${opencodeBaseUrl}/${encodedDir}/session/${sessionId}`;
  };

  const quoteShellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const dockerContainerRef = metadata.containerName ?? metadata.containerId ?? machine.externalId;
  const dockerTailEntryLogsCommand = dockerContainerRef
    ? `docker logs -f --tail 200 ${quoteShellArg(dockerContainerRef)}`
    : null;
  const dockerInspectCommand = dockerContainerRef
    ? `docker inspect ${quoteShellArg(dockerContainerRef)}`
    : null;

  const externalLinks = [
    ...(flyMachineUrl ? [{ label: "Fly Machine", url: flyMachineUrl }] : []),
    ...(flyLogsUrl ? [{ label: "Fly Logs", url: flyLogsUrl }] : []),
    ...(flyGrafanaUrl ? [{ label: "Fly Grafana", url: flyGrafanaUrl }] : []),
    ...(flyNetworkingUrl ? [{ label: "Fly Networking", url: flyNetworkingUrl }] : []),
  ];

  const externalRefs: Array<{ label: string; value: string }> = [];

  if (machine.externalId) {
    externalRefs.push({ label: "External ID", value: machine.externalId });
  }

  if (machine.type === "docker") {
    if (metadata.containerName) {
      externalRefs.push({ label: "Container Name", value: metadata.containerName });
    }
    if (metadata.containerId) {
      externalRefs.push({ label: "Container ID", value: metadata.containerId });
    }
    if (dockerTailEntryLogsCommand) {
      externalRefs.push({ label: "Tail entry logs", value: dockerTailEntryLogsCommand });
    }
    if (dockerInspectCommand) {
      externalRefs.push({ label: "Inspect container", value: dockerInspectCommand });
    }
  }

  if (machine.type === "daytona") {
    const sandboxRef = metadata.sandboxName ?? machine.externalId;
    if (sandboxRef) {
      externalRefs.push({ label: "Sandbox", value: sandboxRef });
    }
  }

  if (flyMachine) {
    externalRefs.push({ label: "Fly App", value: flyMachine.appName });
    externalRefs.push({ label: "Fly Machine ID", value: flyMachine.machineId });
  }

  const issueMessage =
    metadata.provisioningError ??
    ((metadata.daemonStatus === "error" ||
      metadata.daemonStatus === "retrying" ||
      metadata.daemonStatus === "verifying") &&
    metadata.daemonStatusMessage
      ? metadata.daemonStatusMessage
      : null);
  const daemonStatusForDisplay =
    metadata.daemonStatus === "retrying" ? "verifying" : metadata.daemonStatus;

  const machineJson = JSON.stringify(machine, null, 2);

  return (
    <div className="space-y-6 p-4">
      <section className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Current State</h2>
          <span className="text-xs text-muted-foreground">{machine.name}</span>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Machine ID</dt>
            <dd className="mt-1">
              <TypeId id={machine.id} startChars={10} endChars={4} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Type</dt>
            <dd className="mt-1 font-mono text-xs">{machine.type}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">State</dt>
            <dd className="mt-1 font-mono text-xs">{machine.state}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Daemon</dt>
            <dd className="mt-1">
              <DaemonStatus
                state={machine.state}
                daemonStatus={daemonStatusForDisplay}
                daemonReadyAt={metadata.daemonReadyAt}
                daemonStatusMessage={metadata.daemonStatusMessage}
              />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">External ID</dt>
            <dd className="mt-1 truncate font-mono text-xs">{machine.externalId || "(pending)"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Created</dt>
            <dd className="mt-1 text-xs" title={new Date(machine.createdAt).toLocaleString()}>
              {formatDistanceToNow(new Date(machine.createdAt), { addSuffix: true })}
            </dd>
          </div>
        </div>

        {issueMessage && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Current issue
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-destructive/90">
              {issueMessage}
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-medium">External Links</h2>

        {!machine.externalId && (
          <p className="text-xs text-muted-foreground">External identifier not assigned yet.</p>
        )}

        {externalLinks.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {externalLinks.map((link) => (
              <Button key={link.url} variant="outline" size="sm" asChild>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {link.label}
                </a>
              </Button>
            ))}
          </div>
        )}

        {externalRefs.length > 0 && (
          <div className="space-y-2">
            {externalRefs.map((ref) => (
              <div key={`${ref.label}-${ref.value}`} className="rounded-md border p-2">
                <div className="text-[11px] text-muted-foreground">{ref.label}</div>
                <div className="mt-1 flex items-start justify-between gap-2">
                  <code className="min-w-0 flex-1 break-all text-xs">{ref.value}</code>
                  <Button variant="ghost" size="sm" onClick={() => copyToClipboard(ref.value)}>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {externalLinks.length === 0 && externalRefs.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No external links available for this machine yet.
          </p>
        )}
      </section>

      <section className="space-y-4 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-medium">Machine Tools</h2>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => restartDaemon.mutate()}
            disabled={restartDaemon.isPending || machine.state === "archived"}
          >
            <RefreshCw className="h-4 w-4" />
            Restart daemon
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => restartMachine.mutate()}
            disabled={restartMachine.isPending || machine.state === "archived"}
          >
            <RefreshCw className="h-4 w-4" />
            Restart machine
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeleteConfirmOpen(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Services</h3>
          {services.length === 0 ? (
            <p className="text-xs text-muted-foreground">No services available yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              {services.flatMap((service) =>
                service.options.map((option, index) => (
                  <a
                    key={`${service.id}-${index}-${option.url}`}
                    href={option.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate rounded-md border p-2 text-foreground hover:bg-accent"
                  >
                    <span>{service.name}</span>
                    <span className="text-xs text-muted-foreground"> :{service.port}</span>
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      ({getServiceAccessLabel(option)})
                    </span>
                  </a>
                )),
              )}
              {daemonBaseUrl && (
                <a
                  href={`${daemonBaseUrl}/terminal`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate rounded-md border p-2 text-foreground hover:bg-accent"
                >
                  Shell
                </a>
              )}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Pidnap Logs</h3>
          {daemonBaseUrl ? (
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {PIDNAP_PROCESSES.map((processName) => (
                <a
                  key={processName}
                  href={buildTerminalUrl(
                    `tail -n 200 -f /var/log/pidnap/process/${processName}.log`,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate rounded-md border p-2 text-foreground hover:bg-accent"
                >
                  {processName}
                </a>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Daemon shell URL not available yet.</p>
          )}
        </div>
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-medium">Agents</h2>

        {agentsLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading agents...
          </div>
        )}

        {!agentsLoading && agents.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {machine.state === "active" && metadata.daemonStatus === "ready"
              ? "No agents found."
              : "Agents appear once the machine is active and daemon is ready."}
          </p>
        )}

        {agents.length > 0 && (
          <div className="grid grid-cols-1 gap-2">
            {agents.map((agent) => {
              const sessionId = extractSessionId(agent.activeRoute?.destination);
              const attachCmd = getAgentAttachCommand(
                agent.activeRoute?.destination,
                agent.workingDirectory,
              );
              const webUrl = buildOpencodeWebUrl(sessionId, agent.workingDirectory);

              return (
                <div key={agent.path} className="rounded-lg border bg-background p-3">
                  <div className="min-w-0">
                    <div
                      className="truncate text-sm font-medium"
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                      }}
                    >
                      /agents{agent.path}
                    </div>
                    {agent.activeRoute?.destination && (
                      <div
                        className="mt-0.5 truncate text-sm text-muted-foreground"
                        style={{
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                        }}
                      >
                        &rarr; {agent.activeRoute.destination}
                      </div>
                    )}
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      Working directory:{" "}
                      <span
                        className="text-xs"
                        style={{
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                        }}
                      >
                        {agent.workingDirectory}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Last changed:{" "}
                      {agent.updatedAt
                        ? formatDistanceToNow(new Date(agent.updatedAt), { addSuffix: true })
                        : "—"}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
                    {webUrl && (
                      <Button variant="outline" size="sm" asChild>
                        <a href={webUrl} target="_blank" rel="noopener noreferrer">
                          <Globe className="h-3.5 w-3.5" />
                          Web
                        </a>
                      </Button>
                    )}
                    {attachCmd && daemonBaseUrl && (
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={buildTerminalUrl(attachCmd)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <TerminalSquare className="h-3.5 w-3.5" />
                          Attach
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Raw Machine Record</h2>
          <Button variant="outline" size="sm" onClick={() => copyToClipboard(machineJson)}>
            <Copy className="h-4 w-4" />
            Copy JSON
          </Button>
        </div>
        <SerializedObjectCodeBlock data={machine} className="max-h-[30rem]" />
      </section>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete machine?"
        description={`This will permanently delete ${machine.name}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteMachine.mutate()}
        destructive
      />
    </div>
  );
}
