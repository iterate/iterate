import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createClient as createPidnapClient } from "pidnap/client";
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
import { z } from "zod/v4";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.tsx";
import { DaemonStatus } from "../../components/daemon-status.tsx";
import { SerializedObjectCodeBlock } from "../../components/serialized-object-code-block.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { TypeId } from "../../components/type-id.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet.tsx";

/** Pidnap-managed processes — mirrors sandbox/pidnap.config.ts */
const PIDNAP_PROCESSES = [
  "daemon-backend",
  "daemon-frontend",
  "opencode",
  "egress-proxy",
  "trace-viewer",
] as const;
type PidnapProcessName = (typeof PIDNAP_PROCESSES)[number];
type LogStreamState = "idle" | "connecting" | "streaming";

const MAX_TAIL_LINES = 500;

const Search = z.object({
  tail: z.enum(PIDNAP_PROCESSES).optional(),
});

export const Route = createFileRoute("/_auth/proj/$projectSlug/machines/$machineId")({
  validateSearch: Search,
  component: MachineDetailPage,
});

function parseFlyExternalId(externalId: string): { appName: string } | null {
  const trimmed = externalId.trim();
  if (!trimmed) return null;
  return { appName: trimmed };
}

type MachineMetadata = {
  host?: string;
  port?: number;
  ports?: Record<string, number>;
  containerId?: string;
  containerName?: string;
  snapshotName?: string;
  sandboxName?: string;
  fly?: {
    machineId?: string;
  };
  daemonStatus?: "ready" | "error" | "restarting" | "stopping" | "verifying" | "retrying";
  daemonReadyAt?: string;
  daemonStatusMessage?: string;
  provisioningError?: string;
} & Record<string, unknown>;

type ProviderDetailLink = {
  label: string;
  url: string;
};

type ProviderDetailRef = {
  label: string;
  value: string;
};

type ProviderDetails = {
  title: string;
  links: ProviderDetailLink[];
  refs: ProviderDetailRef[];
  emptyMessage: string;
};

function ProviderDetailsCard(props: {
  details: ProviderDetails;
  onCopy: (value: string) => Promise<void>;
}) {
  const { details, onCopy } = props;
  const { title, links, refs, emptyMessage } = details;

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-medium">{title}</h2>

      {links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <Button key={link.url} variant="outline" size="sm" asChild>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                {link.label}
              </a>
            </Button>
          ))}
        </div>
      )}

      {refs.length > 0 && (
        <div className="space-y-2">
          {refs.map((ref) => (
            <div key={`${ref.label}-${ref.value}`} className="rounded-md border p-2">
              <div className="text-[11px] text-muted-foreground">{ref.label}</div>
              <div className="mt-1 flex items-start justify-between gap-2">
                <code className="min-w-0 flex-1 break-all text-xs">{ref.value}</code>
                <Button variant="ghost" size="sm" onClick={() => onCopy(ref.value)}>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {links.length === 0 && refs.length === 0 && (
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      )}
    </section>
  );
}

function MachineDetailPage() {
  const params = useParams({ from: "/_auth/proj/$projectSlug/machines/$machineId" });
  const search = useSearch({ from: "/_auth/proj/$projectSlug/machines/$machineId" });
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [tailLines, setTailLines] = useState<string[]>([]);
  const [tailStreamState, setTailStreamState] = useState<LogStreamState>("idle");
  const tailAbortControllerRef = useRef<AbortController | null>(null);
  const tailSessionIdRef = useRef(0);
  const tailLogViewportRef = useRef<HTMLDivElement | null>(null);

  const tailProcess = search.tail ?? null;
  const tailSheetOpen = tailProcess !== null;

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
  const iterateDaemonProxyUrl = iterateDaemonService?.options.find((option) =>
    option.url.includes("/proxy/3000/"),
  )?.url;
  const pidnapRpcUrl = iterateDaemonProxyUrl
    ? iterateDaemonProxyUrl.replace("/proxy/3000/", "/proxy/9876/rpc")
    : null;
  const opencodeService = services.find((service) => service.id === "opencode");
  const opencodeBaseUrl = opencodeService?.options[0]?.url;

  const flyExternal = machine.type === "fly" ? parseFlyExternalId(machine.externalId) : null;
  const flyMachineId = metadata.fly?.machineId;
  const flyAppName = flyExternal?.appName ?? null;
  const flyMachineUrl =
    flyAppName && flyMachineId
      ? `https://fly.io/apps/${flyAppName}/machines/${flyMachineId}`
      : null;
  const flyRealtimeLogsUrl =
    flyAppName && flyMachineId
      ? `https://fly.io/apps/${flyAppName}/monitoring?${new URLSearchParams({
          instance: flyMachineId,
        }).toString()}`
      : null;
  const flyGrafanaOrgId = import.meta.env.VITE_FLY_GRAFANA_ORG_ID ?? "1440139";
  const flyGrafanaMetricsUrl = flyAppName
    ? `https://fly-metrics.net/d/fly-app/fly-app?${new URLSearchParams({
        from: "now-1h",
        to: "now",
        "var-source": "prometheus_on_fly",
        "var-app": flyAppName,
        "var-region": "All",
        "var-host": "All",
        orgId: flyGrafanaOrgId,
      }).toString()}`
    : null;
  const flyGrafanaLogsUrl = flyAppName
    ? `https://fly-metrics.net/d/fly-logs/fly-logs?${new URLSearchParams({
        from: "now-1h",
        to: "now",
        "var-app": flyAppName,
        orgId: flyGrafanaOrgId,
      }).toString()}`
    : null;
  const flyGrafanaNetworkingUrl = flyAppName
    ? `https://fly-metrics.net/d/fly-edge/fly-edge?${new URLSearchParams({
        from: "now-1h",
        to: "now",
        "var-app": flyAppName,
        orgId: flyGrafanaOrgId,
      }).toString()}`
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
  const providerDetails: ProviderDetails = (() => {
    if (machine.type === "fly") {
      return {
        title: "Fly Machine Details",
        links: [
          ...(flyMachineUrl ? [{ label: "Fly Machine", url: flyMachineUrl }] : []),
          ...(flyGrafanaMetricsUrl
            ? [{ label: "Grafana (Metrics)", url: flyGrafanaMetricsUrl }]
            : []),
          ...(flyRealtimeLogsUrl
            ? [{ label: "Fly Logs (Realtime)", url: flyRealtimeLogsUrl }]
            : []),
          ...(flyGrafanaLogsUrl ? [{ label: "Grafana (Logs)", url: flyGrafanaLogsUrl }] : []),
          ...(flyGrafanaNetworkingUrl
            ? [{ label: "Grafana (Networking)", url: flyGrafanaNetworkingUrl }]
            : []),
        ],
        refs: [
          ...(flyAppName ? [{ label: "Fly App", value: flyAppName }] : []),
          ...(flyMachineId ? [{ label: "Fly Machine ID", value: flyMachineId }] : []),
        ],
        emptyMessage: "No Fly details available yet.",
      };
    }

    if (machine.type === "docker") {
      return {
        title: "Docker Machine Details",
        links: [],
        refs: [
          ...(metadata.containerName
            ? [{ label: "Container Name", value: metadata.containerName }]
            : []),
          ...(metadata.containerId ? [{ label: "Container ID", value: metadata.containerId }] : []),
          ...(dockerTailEntryLogsCommand
            ? [{ label: "Tail entry logs", value: dockerTailEntryLogsCommand }]
            : []),
          ...(dockerInspectCommand
            ? [{ label: "Inspect container", value: dockerInspectCommand }]
            : []),
        ],
        emptyMessage: "No Docker details available yet.",
      };
    }

    if (machine.type === "daytona") {
      const sandboxRef = metadata.sandboxName ?? machine.externalId;
      return {
        title: "Daytona Machine Details",
        links: [],
        refs: [...(sandboxRef ? [{ label: "Sandbox", value: sandboxRef }] : [])],
        emptyMessage: "No Daytona details available yet.",
      };
    }

    return {
      title: "Provider Details",
      links: [],
      refs: [],
      emptyMessage: "No provider-specific details available.",
    };
  })();

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

  const stopTailStream = useCallback(() => {
    tailAbortControllerRef.current?.abort();
    tailAbortControllerRef.current = null;
    tailSessionIdRef.current += 1;
  }, []);

  useEffect(() => {
    return () => {
      stopTailStream();
    };
  }, [stopTailStream]);

  const startTailStream = useCallback(
    async (processName: PidnapProcessName) => {
      if (!pidnapRpcUrl) {
        setTailStreamState("idle");
        return;
      }

      const resolvedPidnapRpcUrl = (() => {
        if (pidnapRpcUrl.startsWith("http://") || pidnapRpcUrl.startsWith("https://")) {
          return pidnapRpcUrl;
        }
        if (typeof window === "undefined") return null;
        try {
          return new URL(pidnapRpcUrl, window.location.origin).toString();
        } catch {
          return null;
        }
      })();

      if (!resolvedPidnapRpcUrl) {
        setTailStreamState("idle");
        toast.error("Failed to resolve pidnap RPC URL");
        return;
      }

      stopTailStream();
      const abortController = new AbortController();
      tailAbortControllerRef.current = abortController;
      const sessionId = tailSessionIdRef.current + 1;
      tailSessionIdRef.current = sessionId;

      setTailLines([]);
      setTailStreamState("connecting");

      try {
        const client = createPidnapClient({ url: resolvedPidnapRpcUrl });
        const iterator = await client.processes.tailLogs(
          {
            target: processName,
            lines: 200,
            follow: true,
            intervalMs: 700,
          },
          { signal: abortController.signal },
        );

        if (tailSessionIdRef.current !== sessionId || abortController.signal.aborted) {
          return;
        }

        setTailStreamState("streaming");
        for await (const event of iterator) {
          if (tailSessionIdRef.current !== sessionId || abortController.signal.aborted) {
            break;
          }

          setTailLines((previous) => {
            const next = [...previous, event.line];
            if (next.length <= MAX_TAIL_LINES) return next;
            return next.slice(next.length - MAX_TAIL_LINES);
          });
        }

        if (tailSessionIdRef.current === sessionId && !abortController.signal.aborted) {
          setTailStreamState("idle");
        }
      } catch (error) {
        if (tailSessionIdRef.current !== sessionId || abortController.signal.aborted) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setTailStreamState("idle");
        toast.error(`Failed to tail ${processName}: ${message}`);
      }
    },
    [pidnapRpcUrl, stopTailStream],
  );

  useEffect(() => {
    if (!tailProcess) {
      stopTailStream();
      setTailLines([]);
      setTailStreamState("idle");
      return;
    }

    void startTailStream(tailProcess);
  }, [startTailStream, stopTailStream, tailProcess]);

  useEffect(() => {
    if (!tailLogViewportRef.current) return;
    tailLogViewportRef.current.scrollTop = tailLogViewportRef.current.scrollHeight;
  }, [tailLines]);

  const openTailSheet = (processName: PidnapProcessName) => {
    navigate({
      search: (previous) => ({ ...previous, tail: processName }),
      replace: true,
    });
  };

  const onTailSheetOpenChange = (open: boolean) => {
    if (open) return;

    navigate({
      search: (previous) => {
        const { tail: _tail, ...rest } = previous;
        return rest;
      },
      replace: true,
    });
  };

  return (
    <div className="space-y-8 p-4">
      <section className="space-y-3 border-b pb-6">
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
          {machine.type !== "fly" && (
            <div>
              <dt className="text-xs text-muted-foreground">External ID</dt>
              <dd className="mt-1 truncate font-mono text-xs">
                {machine.externalId || "(pending)"}
              </dd>
            </div>
          )}
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

      <ProviderDetailsCard details={providerDetails} onCopy={copyToClipboard} />

      <section className="space-y-4 border-b pb-6">
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
          {pidnapRpcUrl ? (
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {PIDNAP_PROCESSES.map((processName) => (
                <Button
                  key={processName}
                  variant="outline"
                  size="sm"
                  className="justify-start truncate"
                  onClick={() => openTailSheet(processName)}
                >
                  Tail {processName}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Pidnap RPC URL not available yet.</p>
          )}
        </div>
      </section>

      <section className="space-y-3 border-b pb-6">
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

      <section className="space-y-3">
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

      <Sheet open={tailSheetOpen} onOpenChange={onTailSheetOpenChange}>
        <SheetContent className="w-[80vw] max-w-[80vw] sm:max-w-[80vw]">
          <SheetHeader>
            <SheetTitle>Tail Logs: {tailProcess ?? "process"}</SheetTitle>
            <SheetDescription>
              Streaming via pidnap oRPC through the authenticated machine proxy.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 px-4 pb-4">
            <div className="mb-2 text-xs text-muted-foreground">
              {tailStreamState === "connecting" && "Connecting..."}
              {tailStreamState === "streaming" && "Streaming..."}
              {tailStreamState === "idle" && "Idle"}
            </div>
            <div
              ref={tailLogViewportRef}
              className="h-full overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap"
            >
              {!pidnapRpcUrl
                ? "Pidnap RPC URL not available yet."
                : tailLines.length > 0
                  ? tailLines.join("\n")
                  : tailStreamState === "connecting"
                    ? "Opening stream..."
                    : "No log lines yet."}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
