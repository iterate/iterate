import { useEffect, useRef, useState } from "react";
import { ORPCError } from "@orpc/client";
import { createFileRoute } from "@tanstack/react-router";
import type { Event } from "@iterate-com/events-contract";
import { Button } from "@iterate-com/ui/components/button";
import { createBrowserOpenApiClient, createBrowserWebSocketClient } from "~/orpc/client.ts";

type RunStatus = "idle" | "connecting" | "streaming" | "completed" | "error";

export const Route = createFileRoute("/_app/codemode")({
  ssr: false,
  staticData: {
    breadcrumb: "Codemode",
  },
  component: CodemodePage,
});

function CodemodePage() {
  const [code, setCode] = useState('async (ctx) => {\n  console.log("hello");\n  return 1 + 1;\n}');
  const [events, setEvents] = useState<Event[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [runToken, setRunToken] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (runToken === 0) return;

    const controller = new AbortController();
    let isCurrent = true;
    const openApiClient = createBrowserOpenApiClient();
    const wsClient = createBrowserWebSocketClient();

    setStatus("connecting");
    setEvents([]);
    setLastError(null);

    void (async () => {
      try {
        const started = await openApiClient.codemode.executeScript(
          { code, providers: [] },
          { signal: controller.signal },
        );

        if (!isCurrent || controller.signal.aborted) return;
        setStatus("streaming");

        const stream = await wsClient.client.codemode.streamEvents(
          {
            afterOffset: started.event.offset > 1 ? started.event.offset - 1 : "start",
            streamPath: started.streamPath,
          },
          { signal: controller.signal },
        );

        for await (const event of stream) {
          if (!isCurrent || controller.signal.aborted) return;
          setEvents((prev) => [...prev, event]);
          if (isScriptExecutionFinished(event, started.event.offset)) {
            break;
          }
        }

        if (!isCurrent || controller.signal.aborted) return;
        setStatus("completed");
      } catch (error) {
        if (!isCurrent || controller.signal.aborted) return;
        const message = error instanceof ORPCError ? error.message : String(error);
        setLastError(message);
        setStatus("error");
      }
    })();

    return () => {
      isCurrent = false;
      controller.abort();
      wsClient.close();
    };
    // runToken is the only trigger -- code is captured at submit time via the closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const resultEvent = events.find(
    (e) => e.type === "events.iterate.com/codemode/script-execution-finished",
  );

  const handleRun = () => {
    setRunToken((n) => n + 1);
  };

  return (
    <div className="flex min-h-full flex-1 flex-col lg:flex-row">
      {/* Input panel */}
      <section className="w-full border-b p-4 lg:max-w-md lg:border-b-0 lg:border-r">
        <div className="max-w-md space-y-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Code</h2>
            <p className="text-sm text-muted-foreground">Write an async codemode function.</p>
          </div>

          <textarea
            className="min-h-[200px] w-full resize-y rounded-lg border bg-card p-3 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            data-testid="codemode-input"
          />

          {lastError && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {lastError}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleRun}
              disabled={
                status === "connecting" || status === "streaming" || code.trim().length === 0
              }
              data-testid="codemode-run"
            >
              {status === "connecting" || status === "streaming" ? "Running..." : "Run"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEvents([]);
                setLastError(null);
                setStatus("idle");
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      </section>

      {/* Output panel */}
      <section className="min-h-0 flex-1 p-4">
        <div className="flex h-full min-h-[320px] flex-col gap-4">
          {/* Result card */}
          {resultEvent && (
            <div
              className={`rounded-lg border p-4 ${
                readEventPayloadString(resultEvent, "error")
                  ? "border-destructive/40 bg-destructive/5"
                  : "border-green-500/40 bg-green-500/5"
              }`}
              data-testid="codemode-result"
            >
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Result
              </p>
              {readEventPayloadString(resultEvent, "error") ? (
                <pre className="whitespace-pre-wrap font-mono text-sm text-destructive">
                  {readEventPayloadString(resultEvent, "error")}
                </pre>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-sm">
                  {formatValue(readEventPayloadValue(resultEvent, "result"))}
                </pre>
              )}
            </div>
          )}

          {/* Event log */}
          <div className="flex flex-1 flex-col rounded-lg border bg-card">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <StatusDot status={status} />
                <span className="font-medium">{statusLabel(status)}</span>
              </div>
              <span className="text-muted-foreground">{events.length} events</span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="codemode-events">
              {events.length > 0 ? (
                <div className="space-y-1 font-mono text-xs leading-5">
                  {events.map((event, i) => (
                    <EventLine key={i} event={event} />
                  ))}
                  <div ref={logEndRef} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Run some code to see streaming execution events here.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function EventLine({ event }: { event: Event }) {
  switch (event.type) {
    case "events.iterate.com/codemode/script-execution-requested":
      return <div className="text-muted-foreground">[script-requested] offset {event.offset}</div>;

    case "events.iterate.com/codemode/log-emitted": {
      const level = readEventPayloadString(event, "level");
      const color =
        level === "error"
          ? "text-destructive"
          : level === "warn"
            ? "text-yellow-600 dark:text-yellow-400"
            : "text-foreground";
      return (
        <div className={color}>
          [{level || "log"}] {readEventPayloadString(event, "message")}
        </div>
      );
    }

    case "events.iterate.com/codemode/tool-provider-registered":
      return (
        <div className="text-muted-foreground">
          [provider-registered] {readEventPayloadPath(event, "path")}
        </div>
      );

    case "events.iterate.com/codemode/tool-function-call-requested":
      return (
        <div className="text-blue-600 dark:text-blue-400">
          [tool-function-call] {readEventPayloadPath(event, "path")}
        </div>
      );

    case "events.iterate.com/codemode/tool-function-call-succeeded":
      return (
        <div className="text-green-600 dark:text-green-400">
          [tool-function-result] {formatValue(readEventPayloadValue(event, "result"))}
        </div>
      );

    case "events.iterate.com/codemode/tool-function-call-failed":
      return (
        <div className="text-destructive">
          [tool-function-error] {formatValue(readEventPayloadValue(event, "error"))}
        </div>
      );

    case "events.iterate.com/codemode/script-execution-finished": {
      const error = readEventPayloadString(event, "error");
      return (
        <div className={error ? "text-destructive" : "text-green-600 dark:text-green-400"}>
          [result] {error ? `error: ${error}` : formatValue(readEventPayloadValue(event, "result"))}
        </div>
      );
    }

    default:
      return (
        <div className="text-muted-foreground">
          [{event.type}] {formatValue(event.payload)}
        </div>
      );
  }
}

function StatusDot({ status }: { status: RunStatus }) {
  const color =
    status === "streaming"
      ? "bg-green-500"
      : status === "connecting"
        ? "animate-pulse bg-yellow-500"
        : status === "error"
          ? "bg-red-500"
          : "bg-muted-foreground/40";

  return <div className={`size-2 rounded-full ${color}`} />;
}

function statusLabel(status: RunStatus) {
  if (status === "connecting") return "Connecting";
  if (status === "streaming") return "Streaming";
  if (status === "completed") return "Completed";
  if (status === "error") return "Error";
  return "Idle";
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function isScriptExecutionFinished(event: Event, scriptExecutionRequestedOffset: number) {
  if (event.type !== "events.iterate.com/codemode/script-execution-finished") return false;
  return (
    readEventPayloadValue(event, "scriptExecutionRequestedOffset") ===
    scriptExecutionRequestedOffset
  );
}

function readEventPayloadValue(event: Event, key: string) {
  const payload = event.payload as Record<string, unknown>;
  return payload[key];
}

function readEventPayloadString(event: Event, key: string) {
  const value = readEventPayloadValue(event, key);
  return typeof value === "string" ? value : "";
}

function readEventPayloadPath(event: Event, key: string) {
  const value = readEventPayloadValue(event, key);
  return Array.isArray(value) ? value.join(".") : "";
}
