import { useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Trash2, RefreshCw, Server, Code2, Terminal, Copy, Bot } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.tsx";
import { DaemonStatus } from "../../components/daemon-status.tsx";
import { HeaderActions } from "../../components/header-actions.tsx";
import { TypeId } from "../../components/type-id.tsx";

export const Route = createFileRoute("/_auth/proj/$projectSlug/machines/$machineId")({
  component: MachineDetailPage,
});

const SERVICE_ICONS: Record<string, typeof Server> = {
  "iterate-daemon": Server,
  opencode: Code2,
};

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

  const { data: agentsData } = useQuery(
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

  const iterateDaemonService = services.find((s) => s.id === "iterate-daemon");

  const buildAgentTerminalUrl = (daemonBaseUrl: string, command: string) => {
    return `${daemonBaseUrl}/terminal?${new URLSearchParams({ command, autorun: "true" })}`;
  };

  const getAgentAttachCommand = (harnessSessionId: string) => {
    const baseCmd = `opencode attach 'http://localhost:4096' --session ${harnessSessionId}`;
    return `${baseCmd} --dir '${agentsData?.customerRepoPath}'`;
  };

  return (
    <div className="space-y-6 p-4">
      <HeaderActions>
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
        <div className="space-y-2">
          {services.map((service) => {
            const Icon = SERVICE_ICONS[service.id] ?? Server;
            return (
              <div
                key={service.id}
                className="flex items-center justify-between rounded-lg border bg-card p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{service.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">:{service.port}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {service.options.map((option, index) => (
                    <a
                      key={index}
                      href={option.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-8 items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {option.label}
                    </a>
                  ))}
                </div>
              </div>
            );
          })}

          {iterateDaemonService && (
            <div className="flex items-center justify-between rounded-lg border bg-card p-3">
              <div className="flex min-w-0 items-center gap-3">
                <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">Shell</div>
                  <div className="text-xs text-muted-foreground">Terminal access</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {iterateDaemonService.options.map((option, index) => (
                  <a
                    key={index}
                    href={`${option.url}/terminal`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {option.label}
                  </a>
                ))}
              </div>
            </div>
          )}

          {commands.length > 0 && iterateDaemonService && (
            <>
              <div className="border-t pt-4">
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">Commands</h3>
              </div>
              {commands.map((cmd, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between rounded-lg border bg-card p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{cmd.label}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {iterateDaemonService.options.map((option, optIndex) => (
                      <a
                        key={optIndex}
                        href={buildAgentTerminalUrl(option.url, cmd.command)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
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

          {agents.length > 0 && (
            <>
              <div className="border-t pt-4">
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">Agents</h3>
              </div>
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center justify-between rounded-lg border bg-card p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{agent.slug}</div>
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
                          className="inline-flex h-8 items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
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
