import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { DeploymentEvent } from "@iterate-com/fake-os-contract";
import { LogViewer } from "../-log-viewer.tsx";
import { orpcClient } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/deployments/$slug/events")({
  component: DeploymentEvents,
});

function DeploymentEvents() {
  const { slug } = Route.useParams();
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error" | "closed">(
    "connecting",
  );
  const iteratorRef = useRef<AsyncIterator<DeploymentEvent> | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    setStatus("connecting");

    void (async () => {
      try {
        const stream = await orpcClient.deployments.events({ slug });
        iteratorRef.current = stream[Symbol.asyncIterator]();
        setStatus("streaming");

        while (true) {
          const next = await iteratorRef.current.next();
          if (next.done) break;
          if (controller.signal.aborted) break;
          const line = eventToLine(next.value);
          if (line !== null) {
            setLines((prev) => {
              const updated = [...prev, line];
              return updated.length > 5000 ? updated.slice(-5000) : updated;
            });
          }
        }
        setStatus("closed");
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setLines((prev) => [...prev, `\x1b[31m[error] ${message}\x1b[0m`]);
        setStatus("error");
      }
    })();

    return () => {
      controller.abort();
      void iteratorRef.current?.return?.();
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

function eventToLine(event: DeploymentEvent): string | null {
  if (event.type === "https://events.iterate.com/deployment/logged") {
    return event.payload.line;
  }
  if (event.type === "https://events.iterate.com/deployment/started") {
    return `\x1b[32m[started]\x1b[0m ${event.payload.detail}`;
  }
  if (event.type === "https://events.iterate.com/deployment/stopped") {
    return `\x1b[33m[stopped]\x1b[0m ${event.payload.detail}`;
  }
  if (event.type === "https://events.iterate.com/deployment/created") {
    return `\x1b[36m[created]\x1b[0m ${event.payload.baseUrl}`;
  }
  if (event.type === "https://events.iterate.com/deployment/destroyed") {
    return `\x1b[31m[destroyed]\x1b[0m`;
  }
  if (event.type === "https://events.iterate.com/deployment/errored") {
    return `\x1b[31m[error]\x1b[0m ${event.payload.message}`;
  }
  return null;
}
