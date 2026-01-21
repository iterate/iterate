import { useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ExternalLink,
  Trash2,
  RefreshCw,
  Server,
  Code2,
  Terminal,
  Copy,
  Bot,
  Circle,
  FileText,
  Clock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog.tsx";
import { DaemonStatus } from "../../../components/daemon-status.tsx";
import { HeaderActions } from "../../../components/header-actions.tsx";
import { TypeId } from "../../../components/type-id.tsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../../components/ui/sheet.tsx";

export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/machines/$machineId",
)({
  component: MachineDetailPage,
});

// Icon map for services
const SERVICE_ICONS: Record<string, typeof Server> = {
  "iterate-daemon": Server,
  opencode: Code2,
};

// PM2 status to color mapping
function getStatusColor(status: string): string {
  switch (status) {
    case "online":
      return "text-green-500 fill-green-500";
    case "launching":
      return "text-yellow-500 fill-yellow-500";
    case "stopping":
    case "stopped":
      return "text-gray-400 fill-gray-400";
    case "errored":
      return "text-red-500 fill-red-500";
    default:
      return "text-gray-400 fill-gray-400";
  }
}

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

// Format uptime to human readable
function formatUptime(ms: number | null): string {
  if (ms === null || ms <= 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function MachineDetailPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/machines/$machineId",
  });
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [logsSheet, setLogsSheet] = useState<{ open: boolean; processName: string | null }>({
    open: false,
    processName: null,
  });

  const machineQueryKey = trpc.machine.byId.queryKey({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    machineId: params.machineId,
  });

  const machineListQueryKey = trpc.machine.list.queryKey({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    includeArchived: false,
  });

  const processesQueryKey = trpc.machine.listProcesses.queryKey({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    machineId: params.machineId,
  });

  const { data: machine } = useSuspenseQuery(
    trpc.machine.byId.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      machineId: params.machineId,
    }),
  );

  const metadata = machine.metadata as {
    host?: string;
    port?: number;
    ports?: Record<string, number>;
    containerId?: string;
    snapshotName?: string;
    daemonStatus?: "ready" | "error" | "restarting" | "stopping";
    daemonReadyAt?: string;
    daemonStatusMessage?: string;
  };

  // Use commands, terminal info, and services from backend
  const { commands, services } = machine;

  // Query PM2 processes with auto-refresh every 5 seconds
  const { data: processesData } = useQuery(
    trpc.machine.listProcesses.queryOptions(
      {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      },
      {
        enabled: machine.state === "active" && metadata.daemonStatus === "ready",
        refetchInterval: 5000, // Refresh every 5 seconds
      },
    ),
  );

  const processes = processesData?.processes ?? [];

  // Query logs when sheet is open
  const { data: logsData, refetch: refetchLogs } = useQuery(
    trpc.machine.getProcessLogs.queryOptions(
      {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
        processName: logsSheet.processName ?? "",
        lines: 200,
        type: "both",
      },
      {
        enabled: logsSheet.open && !!logsSheet.processName,
        refetchInterval: 3000, // Refresh logs every 3 seconds when open
      },
    ),
  );

  // Mutations
  const restartMachine = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.restart.mutate({
        organizationSlug: params.organizationSlug,
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

  const deleteMachine = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.delete.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
    },
    onSuccess: () => {
      toast.success("Machine deleted");
      queryClient.invalidateQueries({ queryKey: machineListQueryKey });
      navigate({
        to: "/orgs/$organizationSlug/projects/$projectSlug/machines",
        params: {
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
        },
      });
    },
    onError: (error) => {
      toast.error("Failed to delete: " + error.message);
    },
  });

  const restartProcess = useMutation({
    mutationFn: async (processName: string) => {
      return trpcClient.machine.restartProcess.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
        processName,
      });
    },
    onSuccess: (_, processName) => {
      toast.success(`Restarting ${processName}`);
      queryClient.invalidateQueries({ queryKey: processesQueryKey });
    },
    onError: (error) => {
      toast.error("Failed to restart process: " + error.message);
    },
  });

  // Copy helper
  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied: ${text}`);
  };

  // Query agents from the daemon
  const { data: agentsData } = useQuery(
    trpc.machine.listAgents.queryOptions(
      {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      },
      {
        enabled: machine.state === "active" && metadata.daemonStatus === "ready",
        refetchInterval: 10000, // Poll every 10s
      },
    ),
  );

  // Sort agents by updatedAt descending (most recent first)
  const agents = [...(agentsData?.agents ?? [])].sort(
    (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
  );

  // Format agent time: show time, add date if >12h ago
  const formatAgentTime = (dateStr: string | null) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    const now = new Date();
    const hoursAgo = (now.getTime() - date.getTime()) / (1000 * 60 * 60);
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (hoursAgo > 12) {
      const dateFormatted = date.toLocaleDateString([], { month: "short", day: "numeric" });
      return `${dateFormatted} ${time}`;
    }
    return time;
  };

  // Get iterate-daemon service for agent terminal access
  const iterateDaemonService = services.find((s) => s.id === "iterate-daemon");

  // Build URL for agent terminal with command (uses iterate-daemon's /terminal endpoint)
  const buildAgentTerminalUrl = (daemonBaseUrl: string, command: string) => {
    const url = new URL(`${daemonBaseUrl}/terminal`, window.location.origin);
    url.searchParams.set("command", command);
    url.searchParams.set("autorun", "true");
    return url.toString();
  };

  // Get attach command for an agent using its harness session ID
  const getAgentAttachCommand = (harnessSessionId: string) =>
    `opencode attach 'http://localhost:4096' --session ${harnessSessionId}`;

  // Get service info for a PM2 process (for web UI links)
  const getServiceForProcess = (processName: string) => {
    return services.find((s) => s.id === processName);
  };

  return (
    <div className="p-4 space-y-6">
      {/* Header Actions */}
      <HeaderActions>
        <Button
          variant="outline"
          size="sm"
          onClick={() => restartMachine.mutate()}
          disabled={restartMachine.isPending || machine.state === "archived"}
        >
          <RefreshCw className="h-4 w-4 mr-1" />
          Restart
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDeleteConfirmOpen(true)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Delete
        </Button>
      </HeaderActions>

      {/* Machine Info Grid */}
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs">ID</dt>
          <dd className="mt-1">
            <TypeId id={machine.id} startChars={10} endChars={4} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Status</dt>
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
          <dt className="text-muted-foreground text-xs">Type</dt>
          <dd className="mt-1">{machine.type}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Created</dt>
          <dd className="mt-1">
            {formatDistanceToNow(new Date(machine.createdAt), { addSuffix: true })}
          </dd>
        </div>
        {metadata.containerId && (
          <div>
            <dt className="text-muted-foreground text-xs">Container</dt>
            <dd className="mt-1">
              <button
                onClick={() => copyToClipboard(metadata.containerId!)}
                className="font-mono text-xs hover:text-foreground text-muted-foreground flex items-center gap-1"
              >
                {metadata.containerId.slice(0, 12)}
                <Copy className="h-3 w-3 opacity-50" />
              </button>
            </dd>
          </div>
        )}
        {metadata.snapshotName && (
          <div>
            <dt className="text-muted-foreground text-xs">Snapshot</dt>
            <dd className="mt-1 font-mono text-xs truncate">{metadata.snapshotName}</dd>
          </div>
        )}
      </div>

      {/* Daemons (PM2 Processes) */}
      {machine.state !== "archived" && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Daemons</h3>

          {processes.length === 0 && metadata.daemonStatus === "ready" && (
            <p className="text-sm text-muted-foreground">Loading processes...</p>
          )}

          {processes.map((proc) => {
            const Icon = SERVICE_ICONS[proc.name] ?? Server;
            const service = getServiceForProcess(proc.name);
            const hasWebUI = !!service;

            return (
              <div
                key={proc.name}
                className="flex items-center justify-between p-3 border rounded-lg bg-card"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Circle className={`h-2 w-2 ${getStatusColor(proc.status)}`} />
                      <span className="text-sm font-medium truncate">
                        {proc.meta?.displayName || proc.name}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <span>{proc.status}</span>
                      {proc.uptime !== null && proc.uptime > 0 && (
                        <>
                          <span>·</span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatUptime(proc.uptime)}
                          </span>
                        </>
                      )}
                      {proc.memory > 0 && (
                        <>
                          <span>·</span>
                          <span>{formatBytes(proc.memory)}</span>
                        </>
                      )}
                      {proc.restarts > 0 && (
                        <>
                          <span>·</span>
                          <span>{proc.restarts} restarts</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {/* Web UI buttons */}
                  {hasWebUI &&
                    service.options.map((option, index) => (
                      <a
                        key={index}
                        href={option.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-sm font-medium h-8 px-2 rounded-md hover:bg-accent hover:text-accent-foreground"
                        title={`Open ${option.label}`}
                      >
                        <ExternalLink className="h-4 w-4" />
                        <span className="sr-only md:not-sr-only">{option.label}</span>
                      </a>
                    ))}
                  {/* Logs button */}
                  <button
                    onClick={() => setLogsSheet({ open: true, processName: proc.name })}
                    className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-sm font-medium h-8 px-2 rounded-md hover:bg-accent hover:text-accent-foreground"
                    title="View logs"
                  >
                    <FileText className="h-4 w-4" />
                    <span className="sr-only md:not-sr-only">Logs</span>
                  </button>
                  {/* Restart button */}
                  <button
                    onClick={() => restartProcess.mutate(proc.name)}
                    disabled={restartProcess.isPending}
                    className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-sm font-medium h-8 px-2 rounded-md hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    title="Restart process"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${restartProcess.isPending ? "animate-spin" : ""}`}
                    />
                    <span className="sr-only md:not-sr-only">Restart</span>
                  </button>
                </div>
              </div>
            );
          })}

          {/* Shell - terminal access via iterate-daemon */}
          {iterateDaemonService && (
            <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
              <div className="flex items-center gap-3 min-w-0">
                <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">Shell</div>
                  <div className="text-xs text-muted-foreground">Terminal access</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {iterateDaemonService?.options.map((option, index) => (
                  <a
                    key={index}
                    href={`${option.url}/terminal`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-sm font-medium h-8 px-3 rounded-md hover:bg-accent hover:text-accent-foreground"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {option.label}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Commands - open in terminal */}
          {commands.length > 0 && iterateDaemonService && (
            <>
              <div className="pt-4 border-t">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">Commands</h3>
              </div>
              {commands.map((cmd, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 border rounded-lg bg-card"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{cmd.label}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {iterateDaemonService.options.map((option, optIndex) => (
                      <a
                        key={optIndex}
                        href={buildAgentTerminalUrl(option.url, cmd.command)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-sm font-medium h-8 px-3 rounded-md hover:bg-accent hover:text-accent-foreground"
                      >
                        <ExternalLink className="h-4 w-4" />
                        {option.label}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Agents */}
          {agents.length > 0 && (
            <>
              <div className="pt-4 border-t">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">Agents</h3>
              </div>
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center justify-between p-3 border rounded-lg bg-card"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{agent.slug}</div>
                      <div className="text-xs text-muted-foreground">
                        {agent.status} · {agent.harnessType} · {formatAgentTime(agent.updatedAt)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {agent.harnessSessionId &&
                      iterateDaemonService?.options.map((option, index) => (
                        <a
                          key={index}
                          href={buildAgentTerminalUrl(
                            option.url,
                            getAgentAttachCommand(agent.harnessSessionId!),
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-sm font-medium h-8 px-3 rounded-md hover:bg-accent hover:text-accent-foreground"
                        >
                          <ExternalLink className="h-4 w-4" />
                          {option.label}
                        </a>
                      ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete machine?"
        description={`This will permanently delete ${machine.name}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteMachine.mutate()}
        destructive
      />

      {/* Logs Sheet */}
      <Sheet open={logsSheet.open} onOpenChange={(open) => setLogsSheet({ ...logsSheet, open })}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-hidden flex flex-col">
          <SheetHeader className="flex-shrink-0">
            <SheetTitle className="flex items-center justify-between">
              <span>Logs: {logsSheet.processName}</span>
              <Button variant="ghost" size="sm" onClick={() => refetchLogs()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-auto mt-4">
            {logsData?.out && (
              <div className="mb-4">
                <h4 className="text-xs font-medium text-muted-foreground mb-2">stdout</h4>
                <pre className="text-xs font-mono bg-muted p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
                  {logsData.out || "(empty)"}
                </pre>
              </div>
            )}
            {logsData?.error && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">stderr</h4>
                <pre className="text-xs font-mono bg-muted p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all text-red-400">
                  {logsData.error || "(empty)"}
                </pre>
              </div>
            )}
            {!logsData?.out && !logsData?.error && (
              <p className="text-sm text-muted-foreground">No logs available</p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
