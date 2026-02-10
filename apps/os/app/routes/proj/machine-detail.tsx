import { useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2, RefreshCw, Copy, Globe, TerminalSquare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.tsx";
import { DaemonStatus } from "../../components/daemon-status.tsx";
import { HeaderActions } from "../../components/header-actions.tsx";
import { TypeId } from "../../components/type-id.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";

export const Route = createFileRoute("/_auth/proj/$projectSlug/machines/$machineId")({
  component: MachineDetailPage,
});

/** Pidnap-managed processes — mirrors apps/os/sandbox/pidnap.config.ts */
const PIDNAP_PROCESSES = [
  "daemon-backend",
  "daemon-frontend",
  "opencode",
  "egress-proxy",
  "trace-viewer",
  "task-install-jaeger",
] as const;

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

  const metadata = machine.metadata as {
    host?: string;
    port?: number;
    ports?: Record<string, number>;
    containerId?: string;
    containerName?: string;
    snapshotName?: string;
    sandboxName?: string;
    daemonStatus?: "ready" | "error" | "restarting" | "stopping";
    daemonReadyAt?: string;
    daemonStatusMessage?: string;
  };

  const { commands, services } = machine;
  const isDockerMachine = machine.type === "local-docker";
  const dockerContainerRef = metadata.containerName ?? metadata.containerId ?? machine.externalId;

  const quoteShellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const dockerTailLogsCommand = dockerContainerRef
    ? `docker logs -f --tail 200 ${quoteShellArg(dockerContainerRef)}`
    : null;

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

  const iterateDaemonService = services.find((s) => s.id === "iterate-daemon");
  const daemonBaseUrl = iterateDaemonService?.options[0]?.url;
  const opencodeService = services.find((s) => s.id === "opencode");
  const opencodeBaseUrl = opencodeService?.options[0]?.url;

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

  return (
    <div className="space-y-6 p-4">
      <HeaderActions>
        {isDockerMachine && dockerTailLogsCommand && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => copyToClipboard(dockerTailLogsCommand)}
            disabled={machine.state === "archived"}
          >
            <Copy className="h-4 w-4" />
            Tail logs
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => restartDaemon.mutate()}
          disabled={restartDaemon.isPending || machine.state === "archived"}
        >
          <RefreshCw className="h-4 w-4" />
          Daemon
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => restartMachine.mutate()}
          disabled={restartMachine.isPending || machine.state === "archived"}
        >
          <RefreshCw className="h-4 w-4" />
          Machine
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setDeleteConfirmOpen(true)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </HeaderActions>

      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">ID</dt>
          <dd className="mt-1">
            <TypeId id={machine.id} startChars={10} endChars={4} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd className="mt-1">
            <DaemonStatus
              state={machine.state}
              daemonStatus={metadata.daemonStatus}
              daemonReadyAt={metadata.daemonReadyAt}
              daemonStatusMessage={metadata.daemonStatusMessage}
            />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Type</dt>
          <dd className="mt-1">{machine.type}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Created</dt>
          <dd className="mt-1">
            {formatDistanceToNow(new Date(machine.createdAt), { addSuffix: true })}
          </dd>
        </div>
        {metadata.containerName && (
          <div>
            <dt className="text-xs text-muted-foreground">Container</dt>
            <dd className="mt-1">
              <button
                onClick={() => copyToClipboard(metadata.containerName!)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {metadata.containerName}
                <Copy className="h-3 w-3 opacity-50" />
              </button>
            </dd>
          </div>
        )}
        {metadata.containerId && !metadata.containerName && (
          <div>
            <dt className="text-xs text-muted-foreground">Container ID</dt>
            <dd className="mt-1">
              <button
                onClick={() => copyToClipboard(metadata.containerId!)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {metadata.containerId.slice(0, 12)}
                <Copy className="h-3 w-3 opacity-50" />
              </button>
            </dd>
          </div>
        )}
        {metadata.snapshotName && (
          <div>
            <dt className="text-xs text-muted-foreground">Snapshot</dt>
            <dd className="mt-1 truncate font-mono text-xs">{metadata.snapshotName}</dd>
          </div>
        )}
        {machine.type === "daytona" && (
          <div>
            <dt className="text-xs text-muted-foreground">Sandbox</dt>
            <dd className="mt-1">
              <button
                onClick={() => copyToClipboard(metadata.sandboxName ?? machine.externalId)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <span className="truncate">{metadata.sandboxName ?? machine.externalId}</span>
                <Copy className="h-3 w-3 shrink-0 opacity-50" />
              </button>
            </dd>
          </div>
        )}
      </div>

      {machine.state !== "archived" && (
        <div className="space-y-4">
          {/* Services */}
          <div>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Services</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
              {services.flatMap((service) =>
                service.options.map((option, i) => (
                  <a
                    key={`${service.id}-${i}-${option.url}`}
                    href={option.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-foreground hover:underline"
                  >
                    {service.name}{" "}
                    <span className="text-xs text-muted-foreground">:{service.port}</span>
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
                  className="truncate text-foreground hover:underline"
                >
                  Shell
                </a>
              )}
            </div>
          </div>

          {/* Pidnap Logs */}
          {daemonBaseUrl && (
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">Pidnap Logs</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                {PIDNAP_PROCESSES.map((proc) => (
                  <a
                    key={proc}
                    href={buildTerminalUrl(`tail -n 200 -f /var/log/pidnap/process/${proc}.log`)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-foreground hover:underline"
                  >
                    {proc}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Commands */}
          {commands.length > 0 && daemonBaseUrl && (
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">Commands</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                {commands.map((cmd, i) => (
                  <a
                    key={i}
                    href={buildTerminalUrl(cmd.command)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-foreground hover:underline"
                  >
                    {cmd.label}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Agents */}
          {agentsLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Loading agents...
            </div>
          )}
          {agents.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                Agents ({agents.length})
              </h3>
              <div className="grid grid-cols-1 gap-2">
                {agents.map((agent) => {
                  const sessionId = extractSessionId(agent.activeRoute?.destination);
                  const attachCmd = getAgentAttachCommand(
                    agent.activeRoute?.destination,
                    agent.workingDirectory,
                  );
                  const webUrl = buildOpencodeWebUrl(sessionId, agent.workingDirectory);
                  return (
                    <div key={agent.path} className="rounded-lg border bg-card p-3">
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
                          <Button variant="outline" size="sm" asChild className="shadow-sm">
                            <a href={webUrl} target="_blank" rel="noopener noreferrer">
                              <Globe className="h-3.5 w-3.5" />
                              Web
                            </a>
                          </Button>
                        )}
                        {attachCmd && daemonBaseUrl && (
                          <Button variant="outline" size="sm" asChild className="shadow-sm">
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
            </div>
          )}
        </div>
      )}

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
