import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import {
  buildCounterExplorerLinks,
  buildCounterPublicPath,
  type CounterState,
} from "~/lib/counter-durable-objects.ts";

type CounterConnectionState = "connecting" | "connected" | "disconnected";

export const Route = createFileRoute("/_app/counters/$name")({
  loader: ({ params }) => ({
    breadcrumb: params.name,
  }),
  component: CounterDetailPage,
});

function CounterDetailPage() {
  const { name } = Route.useParams();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["durable-counter", name] as const, [name]);
  const [connectionState, setConnectionState] = useState<CounterConnectionState>("disconnected");
  const counter = useQuery({
    queryKey,
    queryFn: () => fetchCounter(buildCounterPublicPath(name)),
    retry: false,
  });
  const increment = useMutation({
    mutationFn: () => fetchCounter(`${buildCounterPublicPath(name)}/increment`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });
  const reset = useMutation({
    mutationFn: () => fetchCounter(`${buildCounterPublicPath(name)}/reset`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });
  const busy = counter.isPending || increment.isPending || reset.isPending;
  const publicPath = buildCounterPublicPath(name);
  const explorerLinks = counter.data?.explorerLinks ?? buildCounterExplorerLinks(publicPath);

  useEffect(() => {
    if (!counter.isSuccess) return;

    setConnectionState("connecting");
    const socket = new WebSocket(createCounterWebSocketUrl(name));

    socket.addEventListener("open", () => setConnectionState("connected"));
    socket.addEventListener("close", () => setConnectionState("disconnected"));
    socket.addEventListener("error", () => setConnectionState("disconnected"));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      const state = parseCounterStateMessage(event.data);
      if (!state) return;

      queryClient.setQueryData(queryKey, state);
    });

    return () => {
      socket.close();
    };
  }, [counter.isSuccess, name, queryClient, queryKey]);

  return (
    <section className="space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{name}</h2>
        <p className="text-sm text-muted-foreground">
          A named counter Durable Object initialized from two dimensions.
        </p>
      </div>

      {counter.isError ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          This counter is not initialized, or Durable Object endpoints are not available in this
          runtime.
        </p>
      ) : (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div className="space-y-1">
            <p className="text-4xl font-semibold tabular-nums">{counter.data?.count ?? 0}</p>
            <p className="text-sm text-muted-foreground">
              {counter.data?.updatedAt
                ? `Last updated ${new Date(counter.data.updatedAt).toLocaleString()}`
                : "Not updated yet"}
            </p>
            <p className="text-sm text-muted-foreground">WebSocket {connectionState}</p>
          </div>

          {counter.data && (
            <div className="space-y-1 text-sm">
              <p>
                <span className="text-muted-foreground">Scope</span> {counter.data.scope}
              </p>
              <p>
                <span className="text-muted-foreground">Variant</span> {counter.data.variant}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || counter.isError} onClick={() => increment.mutate()}>
          Increment
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || counter.isError}
          onClick={() => reset.mutate()}
        >
          Reset
        </Button>
        <Button
          size="sm"
          variant="ghost"
          nativeButton={false}
          render={<Link to="/durable-objects" />}
        >
          Back
        </Button>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        <a
          className="text-primary hover:underline"
          href={explorerLinks.kv}
          target="_blank"
          rel="noreferrer"
        >
          KV explorer
        </a>
        <a
          className="text-primary hover:underline"
          href={explorerLinks.kvJson}
          target="_blank"
          rel="noreferrer"
        >
          KV JSON
        </a>
        <a
          className="text-primary hover:underline"
          href={explorerLinks.sql}
          target="_blank"
          rel="noreferrer"
        >
          SQL explorer
        </a>
      </div>
    </section>
  );
}

function createCounterWebSocketUrl(name: string) {
  const url = new URL(`${buildCounterPublicPath(name)}/websocket`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function fetchCounter(path: string, init?: RequestInit): Promise<CounterState> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Counter request failed: ${response.status}`);
  }

  return parseCounterState(await response.json());
}

function parseCounterStateMessage(raw: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.type !== "counter-state") return null;
    return parseCounterState(parsed);
  } catch {
    return null;
  }
}

function parseCounterState(value: unknown): CounterState {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.variant !== "string" ||
    typeof value.count !== "number" ||
    typeof value.publicPath !== "string" ||
    !isRecord(value.explorerLinks)
  ) {
    throw new Error("Counter response was not valid.");
  }

  return {
    name: value.name,
    scope: value.scope,
    variant: value.variant,
    count: value.count,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    publicPath: value.publicPath,
    explorerLinks: {
      kv: String(value.explorerLinks.kv),
      kvJson: String(value.explorerLinks.kvJson),
      sql: String(value.explorerLinks.sql),
      sqlEndpoint: String(value.explorerLinks.sqlEndpoint),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
