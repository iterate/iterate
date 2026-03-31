import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { DeploymentLogEntry } from "@iterate-com/fake-os-contract";
import { LogViewer } from "../-log-viewer.tsx";
import { orpcClient } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/deployments/$slug/events")({
  component: DeploymentLogs,
});

function DeploymentLogs() {
  const { slug } = Route.useParams();
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error" | "closed">(
    "connecting",
  );

  useEffect(() => {
    const controller = new AbortController();
    let isCurrent = true;
    let iterator: AsyncIterator<DeploymentLogEntry> | undefined;
    setLines([]);
    setStatus("connecting");

    void (async () => {
      try {
        const stream = await orpcClient.deployments.logs({ slug });
        iterator = stream[Symbol.asyncIterator]();
        if (!isCurrent || controller.signal.aborted) return;
        setStatus("streaming");

        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          if (controller.signal.aborted) break;
          setLines((prev) => {
            const updated = [...prev, logEntryToLine(next.value)];
            return updated.length > 5000 ? updated.slice(-5000) : updated;
          });
        }
        if (!isCurrent || controller.signal.aborted) return;
        setStatus("closed");
      } catch (error) {
        if (!isCurrent || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setLines((prev) => [...prev, `\x1b[31m[error] ${message}\x1b[0m`]);
        setStatus("error");
      }
    })();

    return () => {
      isCurrent = false;
      controller.abort();
      void iterator?.return?.();
    };
  }, [slug]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground border-b bg-muted/30">
        <StatusDot status={status} />
        <span>
          {status === "connecting" && "Connecting..."}
          {status === "streaming" && `Streaming · ${lines.length} lines`}
          {status === "error" && "Stream error"}
          {status === "closed" && `Stream ended · ${lines.length} lines`}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <LogViewer lines={lines} />
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "streaming"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500 animate-pulse"
        : status === "error"
          ? "bg-red-500"
          : "bg-gray-500";
  return <div className={`size-2 rounded-full ${color}`} />;
}

function logEntryToLine(entry: DeploymentLogEntry): string {
  return entry.timestamp ? `${entry.timestamp} ${entry.text}` : entry.text;
}
