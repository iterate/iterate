import { useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Trash2, RefreshCw, Server, Code2, Terminal, Copy, Bot } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog.tsx";
import { DaemonStatus } from "../../../components/daemon-status.tsx";
import { HeaderActions } from "../../../components/header-actions.tsx";
import { TypeId } from "../../../components/type-id.tsx";

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

function MachineDetailPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/machines/$machineId",
  });
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

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

  const { data: machine } = useSuspenseQuery(
    trpc.machine.byId.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      machineId: params.machineId,
    }),
  );

  const metadata = (machine.metadata as Record<string, unknown>) ?? {};
  const daemonStatus =
    metadata.daemonStatus === "ready" ||
    metadata.daemonStatus === "error" ||
    metadata.daemonStatus === "restarting" ||
    metadata.daemonStatus === "stopping"
      ? metadata.daemonStatus
      : undefined;
  const daemonReadyAt = typeof metadata.daemonReadyAt === "string" ? metadata.daemonReadyAt : null;
  const daemonStatusMessage =
    typeof metadata.daemonStatusMessage === "string" ? metadata.daemonStatusMessage : null;
  const metadataJson = JSON.stringify(metadata, null, 2);

  // Use service info from backend
  const { services } = machine;

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

  const restartDaemon = useMutation({
    mutationFn: async () => {
      return trpcClient.machine.restartDaemon.mutate({
        organizationSlug: params.organizationSlug,
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
        enabled: machine.state === "active" && daemonStatus === "ready",
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
    return `${daemonBaseUrl}/terminal?${new URLSearchParams({ command, autorun: "true" })}`;
  };

  // Get attach command for an agent using its harness session ID
  const getAgentAttachCommand = (harnessSessionId: string) => {
    const baseCmd = `opencode attach 'http://localhost:4096' --session ${harnessSessionId}`;
    return `${baseCmd} --dir '${agentsData?.customerRepoPath}'`;
  };

  return (
    <div className="p-4 space-y-6">
      {/* Header Actions */}
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
              daemonStatus={daemonStatus}
              daemonReadyAt={daemonReadyAt ?? undefined}
              daemonStatusMessage={daemonStatusMessage ?? undefined}
            />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Type</dt>
          <dd className="mt-1">{machine.type}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">External ID</dt>
          <dd className="mt-1 font-mono text-xs truncate">{machine.externalId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Created</dt>
          <dd className="mt-1">
            {formatDistanceToNow(new Date(machine.createdAt), { addSuffix: true })}
          </dd>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Metadata</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copyToClipboard(metadataJson)}
            className="h-7 px-2"
          >
            <Copy className="h-3 w-3 mr-1" />
            Copy JSON
          </Button>
        </div>
        <pre className="border rounded-lg bg-card p-3 font-mono text-xs overflow-x-auto">
          {metadataJson}
        </pre>
      </div>

      {/* Services List */}
      {machine.state !== "archived" && (
        <div className="space-y-2">
          {/* Services */}
          {services.map((service) => {
            const Icon = SERVICE_ICONS[service.id] ?? Server;
            return (
              <div
                key={service.id}
                className="flex items-center justify-between p-3 border rounded-lg bg-card"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{service.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">:{service.port}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {service.options.map((option, index) => (
                    <a
                      key={index}
                      href={option.url}
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
