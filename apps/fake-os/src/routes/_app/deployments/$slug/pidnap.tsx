import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { CopyIcon, RotateCwIcon } from "lucide-react";
import type { PidnapLogEntry } from "@iterate-com/fake-os-contract";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { ScrollArea } from "@iterate-com/ui/components/scroll-area";
import { LogViewer } from "../-log-viewer.tsx";
import { orpc, orpcClient } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/deployments/$slug/pidnap")({
  component: DeploymentPidnapPage,
});

function DeploymentPidnapPage() {
  const { slug } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: managerStatus } = useSuspenseQuery({
    ...orpc.deployments.pidnap.status.queryOptions({ input: { slug } }),
    refetchInterval: 2_000,
  });
  const { data: processes } = useSuspenseQuery({
    ...orpc.deployments.pidnap.processes.queryOptions({ input: { slug } }),
    refetchInterval: 2_000,
  });

  const [selectedProcessName, setSelectedProcessName] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "streaming" | "error" | "closed">(
    "connecting",
  );
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  const selectedProcess = useMemo(() => {
    if (processes.length === 0) return null;
    return (
      processes.find((process) => process.name === selectedProcessName) ?? processes[0] ?? null
    );
  }, [processes, selectedProcessName]);
  const selectedProcessSlug = selectedProcess?.name ?? null;

  const restartMutation = useMutation(
    orpc.deployments.pidnap.restart.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: orpc.deployments.pidnap.status.key({ input: { slug } }),
          }),
          queryClient.invalidateQueries({
            queryKey: orpc.deployments.pidnap.processes.key({ input: { slug } }),
          }),
        ]);
      },
    }),
  );

  useEffect(() => {
    if (!selectedProcessSlug) {
      setLines([]);
      setStreamStatus("closed");
      return;
    }

    const controller = new AbortController();
    let isCurrent = true;
    let iterator: AsyncIterator<PidnapLogEntry> | undefined;
    setLines([]);
    setStreamStatus("connecting");

    void (async () => {
      try {
        const stream = await orpcClient.deployments.pidnap.logs(
          { slug, processSlug: selectedProcessSlug },
          { signal: controller.signal },
        );
        iterator = stream[Symbol.asyncIterator]();
        if (!isCurrent || controller.signal.aborted) return;
        setStreamStatus("streaming");

        while (true) {
          const next = await iterator.next();
          if (next.done || controller.signal.aborted) break;
          setLines((previous) => {
            const updated = [...previous, next.value.text];
            return updated.length > 5_000 ? updated.slice(-5_000) : updated;
          });
        }

        if (!isCurrent || controller.signal.aborted) return;
        setStreamStatus("closed");
      } catch (error) {
        if (!isCurrent || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setLines((previous) => [...previous, `[error] ${message}`]);
        setStreamStatus("error");
      }
    })();

    return () => {
      isCurrent = false;
      controller.abort();
      void iterator?.return?.();
    };
  }, [selectedProcessSlug, slug]);

  async function handleCopyLogs() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1_500);
    } catch {
      setCopyStatus("error");
      window.setTimeout(() => setCopyStatus("idle"), 2_000);
    }
  }

  return (
    <div className="h-full overflow-hidden p-4">
      <div className="grid h-full gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="min-h-0 overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Pidnap</h2>
                <p className="text-xs text-muted-foreground">
                  Manager: {managerStatus.state} · {managerStatus.processCount} processes
                </p>
              </div>
              <StatusBadge status={managerStatus.state} />
            </div>
          </div>

          {processes.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              No pidnap processes found.
            </div>
          ) : (
            <ScrollArea className="h-[calc(100%-73px)]">
              <div className="space-y-3 p-3">
                {processes.map((process) => {
                  const isSelected = process.name === selectedProcess?.name;
                  const isRestarting =
                    restartMutation.isPending &&
                    restartMutation.variables?.processSlug === process.name;

                  return (
                    <div
                      key={process.name}
                      className={`rounded-lg border p-3 transition-colors ${
                        isSelected
                          ? "border-primary bg-accent/40"
                          : "bg-background hover:bg-accent/20"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => setSelectedProcessName(process.name)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate font-medium">{process.name}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {process.definition.command}
                            {process.definition.args?.length
                              ? ` ${process.definition.args.join(" ")}`
                              : ""}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <StatusDot status={process.state} />
                            <span>{process.state}</span>
                            <span>restarts {process.restarts}</span>
                          </div>
                        </button>

                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={restartMutation.isPending}
                          onClick={() => {
                            restartMutation.mutate({ slug, processSlug: process.name });
                          }}
                        >
                          <RotateCwIcon className={isRestarting ? "animate-spin" : undefined} />
                          Restart
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </section>

        <section className="min-h-0 overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-3">
            {selectedProcess ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{selectedProcess.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <StatusDot status={selectedProcess.state} />
                    <span>{selectedProcess.state}</span>
                    <span>stream {streamStatus}</span>
                    <span>{lines.length} lines</span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Log file:{" "}
                    <span className="font-mono text-foreground">
                      {buildPidnapLogPath(selectedProcess.name)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void handleCopyLogs()}
                    disabled={lines.length === 0}
                  >
                    <CopyIcon />
                    {copyStatus === "copied"
                      ? "Copied"
                      : copyStatus === "error"
                        ? "Copy failed"
                        : "Copy logs"}
                  </Button>
                  <div className="text-xs text-muted-foreground">
                    {selectedProcess.definition.cwd ?? "No cwd"}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Select a process to view logs.</div>
            )}
          </div>

          <div className="h-[calc(100%-73px)]">
            <LogViewer lines={lines} />
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      <StatusDot status={status} />
      {status}
    </Badge>
  );
}

function StatusDot({ status }: { status: string }) {
  const className =
    status === "running"
      ? "bg-green-500"
      : status === "restarting"
        ? "bg-yellow-500"
        : status === "stopping"
          ? "bg-orange-500"
          : status === "stopped"
            ? "bg-gray-400"
            : status === "crash-loop-backoff" || status === "max-restarts-reached"
              ? "bg-red-500"
              : "bg-gray-500";

  return <span className={`inline-block size-2 rounded-full ${className}`} />;
}

function buildPidnapLogPath(processName: string) {
  return `/var/log/pidnap/process/${processName}.log`;
}
