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
  FileText,
  ScrollText,
  Bot,
} from "lucide-react";
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

// Service definitions
const SERVICE_DEFS = [
  {
    id: "iterate-daemon",
    name: "Iterate Daemon",
    port: 3000,
    logPath: "/var/log/iterate-daemon/current",
    icon: Server,
  },
  {
    id: "opencode",
    name: "OpenCode",
    port: 4096,
    logPath: "/var/log/opencode/current",
    icon: Code2,
  },
];

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

  const isLocalDocker = machine.type === "local-docker";
  const isLocal = machine.type === "local";
  const isDaytona = machine.type === "daytona";

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

  // URL helpers
  const openServiceUrl = async (serviceId: string, useNative: boolean) => {
    try {
      const result = await trpcClient.machine.getPreviewInfo.query({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
      const daemon = result.daemons.find((d: { id: string }) => d.id === serviceId);
      if (!daemon) {
        toast.error(`Service ${serviceId} not found`);
        return;
      }
      const url = useNative ? daemon.nativeUrl : daemon.proxyUrl;
      if (url) {
        window.open(url, "_blank");
      } else {
        toast.error("URL not available");
      }
    } catch (err) {
      toast.error(`Failed to get URL: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const openTerminal = async ({
    useNative,
    command,
    autorun,
  }: {
    useNative: boolean;
    command?: string;
    autorun?: boolean;
  }) => {
    try {
      const result = await trpcClient.machine.getPreviewInfo.query({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
      const urlBase = useNative ? result.nativeTerminalUrl : result.terminalUrl;
      if (urlBase) {
        const url = new URL(urlBase);
        if (command) {
          url.searchParams.set("command", command);
          url.searchParams.set("autorun", autorun ? "true" : "false");
        }
        window.open(url, "_blank");
      } else {
        toast.error("Terminal URL not available");
      }
    } catch (err) {
      toast.error(`Failed to get URL: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Copy helpers
  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied: ${text}`);
  };

  const copyLogsCommand = (service: (typeof SERVICE_DEFS)[number]) => {
    const command = `tail -f ${service.logPath}`;
    if (isLocalDocker && metadata.containerId) {
      copyToClipboard(`docker exec ${metadata.containerId} ${command}`);
    } else {
      copyToClipboard(command);
    }
  };

  const copyEntryLogsCommand = () => {
    if (isLocalDocker && metadata.containerId) {
      copyToClipboard(`docker logs -f ${metadata.containerId}`);
    } else if (isDaytona) {
      toast.info("Entry logs for Daytona machines go to container stdout");
    }
  };

  const copyTerminalCommand = () => {
    if (isLocalDocker && metadata.containerId) {
      copyToClipboard(`docker exec -it ${metadata.containerId} /bin/bash`);
    }
  };

  // Get port for a service (from metadata or default)
  const getServicePort = (serviceId: string, defaultPort: number) => {
    return metadata.ports?.[serviceId] ?? defaultPort;
  };

  // Check if machine supports dual access (proxy + direct)
  const hasDualAccess = isDaytona || isLocalDocker;

  // Query agents from the daemon
  const { data: agentsData } = useQuery(
    trpc.machine.listAgents.queryOptions(
      {
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      },
      {
        enabled: machine.state === "started" && metadata.daemonStatus === "ready",
        refetchInterval: 10000, // Poll every 10s
      },
    ),
  );

  const agents = agentsData?.agents ?? [];

  // URL helpers for agents - opens terminal with prefilled command
  const openAgentTerminal = async ({
    agentSlug,
    useNative,
    command,
    autorun,
  }: {
    agentSlug: string;
    useNative: boolean;
    command?: string;
    autorun?: boolean;
  }) => {
    try {
      const result = await trpcClient.machine.getPreviewInfo.query({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        machineId: params.machineId,
      });
      const daemon = result.daemons.find((d: { id: string }) => d.id === "iterate-daemon");
      if (!daemon) {
        toast.error("Daemon URL not found");
        return;
      }
      const baseUrl = useNative ? daemon.nativeUrl : daemon.proxyUrl;
      if (baseUrl) {
        agentSlug; // fill in this and construct the command
        const url = new URL(`${baseUrl}/terminal`);
        if (command) {
          url.searchParams.set("command", command);
          url.searchParams.set("autorun", autorun ? "true" : "false");
        }
        window.open(url, "_blank");
      } else {
        toast.error("URL not available");
      }
    } catch (err) {
      toast.error(`Failed to get URL: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="p-4 space-y-6">
      {/* Header Actions */}
      <HeaderActions>
        <Button
          variant="outline"
          size="sm"
          onClick={() => restartMachine.mutate()}
          disabled={restartMachine.isPending || machine.state !== "started"}
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

      {/* Services List */}
      {machine.state === "started" && (
        <div className="space-y-2">
          {SERVICE_DEFS.map((service) => {
            const Icon = service.icon;
            const port = getServicePort(service.id, service.port);
            return (
              <div
                key={service.id}
                className="flex items-center justify-between p-3 border rounded-lg bg-card"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{service.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">:{port}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {hasDualAccess ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openServiceUrl(service.id, true)}
                      >
                        <ExternalLink className="h-4 w-4 mr-1" />
                        Direct
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openServiceUrl(service.id, false)}
                      >
                        <ExternalLink className="h-4 w-4 mr-1" />
                        Proxy
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openServiceUrl(service.id, true)}
                    >
                      <ExternalLink className="h-4 w-4 mr-1" />
                      Open
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => copyLogsCommand(service)}>
                    <FileText className="h-4 w-4 mr-1" />
                    Logs
                  </Button>
                </div>
              </div>
            );
          })}

          {/* Shell */}
          <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
            <div className="flex items-center gap-3 min-w-0">
              <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Shell</div>
                <div className="text-xs text-muted-foreground">Terminal access</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {isDaytona && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openTerminal({ useNative: true })}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    Direct
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openTerminal({ useNative: false })}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    Proxy
                  </Button>
                </>
              )}
              {isLocalDocker && (
                <Button variant="ghost" size="sm" onClick={copyTerminalCommand}>
                  <Copy className="h-4 w-4 mr-1" />
                  Copy command
                </Button>
              )}
              {isLocal && <span className="text-xs text-muted-foreground">SSH or local</span>}
            </div>
          </div>

          {/* Entry logs (boot logs) */}
          {(isLocalDocker || isDaytona) && (
            <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
              <div className="flex items-center gap-3 min-w-0">
                <ScrollText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">Entry Logs</div>
                  <div className="text-xs text-muted-foreground">Container boot logs</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={copyEntryLogsCommand}>
                  <Copy className="h-4 w-4 mr-1" />
                  {isLocalDocker ? "Copy command" : "Info"}
                </Button>
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
                        {agent.harnessType} · {agent.status}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {hasDualAccess ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            openAgentTerminal({
                              agentSlug: agent.slug,
                              useNative: true,
                              command: `opencode attach 'http://localhost:4096' --session "$(opencode session list | grep ${agent.slug} | cut -d' ' -f1)"`,
                              autorun: true,
                            })
                          }
                        >
                          <ExternalLink className="h-4 w-4 mr-1" />
                          Direct
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            openAgentTerminal({
                              agentSlug: agent.slug,
                              useNative: false,
                              command: `echo ${agent.slug}`,
                            })
                          }
                        >
                          <ExternalLink className="h-4 w-4 mr-1" />
                          Proxy
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          openAgentTerminal({
                            agentSlug: agent.slug,
                            useNative: true,
                            command: `echo ${agent.slug}`,
                          })
                        }
                      >
                        <ExternalLink className="h-4 w-4 mr-1" />
                        Open
                      </Button>
                    )}
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
