import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Database } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@iterate-com/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";

export const Route = createFileRoute("/_app/db")({
  ssr: false,
  component: DbPage,
});

type DbBridgeRequest =
  | { type: "query"; id: number; statement: string }
  | { type: "transaction"; id: number; statements: string[] };

interface DbSourcesResponse {
  sources: Array<{
    id: string;
    host: string;
    title: string;
    publicURL: string;
    sqlitePath: string;
    sqliteAlias: string;
    tags: string[];
    updatedAt: string;
  }>;
  total: number;
}

interface DbRuntimeResponse {
  studioSrc: string;
  selectedMainAlias: string;
  databases: Array<{
    alias: string;
    path: string;
    host?: string;
    title?: string;
  }>;
  mainPath: string;
  attached: Record<string, string>;
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function isDbBridgeRequest(value: unknown): value is DbBridgeRequest {
  if (!value || typeof value !== "object" || !("type" in value) || !("id" in value)) {
    return false;
  }

  if (value.type === "query") {
    return (
      "statement" in value && typeof value.statement === "string" && typeof value.id === "number"
    );
  }

  if (value.type === "transaction") {
    return (
      "statements" in value &&
      Array.isArray(value.statements) &&
      value.statements.every((statement) => typeof statement === "string") &&
      typeof value.id === "number"
    );
  }

  return false;
}

function describeRuntimeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Failed to load the embedded DB viewer.";
}

function DbPage() {
  const [requestedMainAlias, setRequestedMainAlias] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("mainAlias") ?? "";
  });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const { data: sourcesData } = useQuery<DbSourcesResponse>({
    queryKey: ["registry", "db", "sources"],
    queryFn: async () => await fetchJson<DbSourcesResponse>("/api/db/sources"),
  });
  const sources = sourcesData?.sources ?? [];
  const runtimeQuery = useQuery<DbRuntimeResponse>({
    queryKey: ["registry", "db", "runtime", requestedMainAlias.trim()],
    queryFn: async () => {
      const url = new URL("/api/db/runtime", window.location.origin);
      if (requestedMainAlias.trim()) {
        url.searchParams.set("mainAlias", requestedMainAlias.trim());
      }
      return await fetchJson<DbRuntimeResponse>(url);
    },
    enabled: sources.length > 0,
  });

  const runtimeData = runtimeQuery.data;
  const selectedMainAlias = runtimeData?.selectedMainAlias ?? "";
  const allowedStudioOrigins = useMemo(() => {
    if (!runtimeData) return [];
    return Array.from(
      new Set([
        new URL(runtimeData.studioSrc).origin,
        "https://studio.outerbase.com",
        "https://libsqlstudio.com",
      ]),
    );
  }, [runtimeData]);

  useEffect(() => {
    if (!runtimeData) return;

    const listener = (event: MessageEvent<unknown>) => {
      if (!allowedStudioOrigins.includes(event.origin)) return;
      if (!isDbBridgeRequest(event.data)) return;
      const request = event.data;
      const url = new URL("/api/db/query", window.location.origin);

      void fetchJson<unknown>(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...(selectedMainAlias ? { mainAlias: selectedMainAlias } : {}),
          request,
        }),
      })
        .then((payload) => {
          iframeRef.current?.contentWindow?.postMessage(payload, event.origin);
        })
        .catch((error: unknown) => {
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: request.type,
              id: request.id,
              error: error instanceof Error ? error.message : String(error),
            },
            event.origin,
          );
        });
    };

    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
    };
  }, [allowedStudioOrigins, runtimeData, selectedMainAlias]);

  return (
    <div className="-m-4 flex min-h-[calc(100vh-2rem)] flex-col overflow-hidden">
      {sources.length === 0 ? (
        <Empty className="m-4">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Database className="size-5" />
            </EmptyMedia>
            <EmptyTitle>No sqlite sources</EmptyTitle>
            <EmptyDescription>
              Add a route tagged `sqlite` with `sqlitePath` metadata.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {sources.length > 0 && runtimeQuery.isPending ? (
        <p className="m-4 text-sm text-muted-foreground">Loading embedded DB viewer...</p>
      ) : null}

      {sources.length > 0 && runtimeQuery.error ? (
        <Card className="m-4 border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <CircleAlert className="size-4" />
              Could not initialize the DB viewer
            </CardTitle>
            <CardDescription className="text-destructive/90">
              {describeRuntimeError(runtimeQuery.error)}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {runtimeData ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950">
          <div className="flex items-center gap-3 border-b border-slate-900 bg-slate-950 px-3 py-2">
            <label
              htmlFor="db-main-picker"
              className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400"
            >
              Service
            </label>
            <select
              id="db-main-picker"
              className="min-w-60 border-0 bg-transparent px-0 py-0 text-sm text-slate-100 outline-none"
              value={selectedMainAlias}
              onChange={(event) => {
                const nextAlias = event.target.value;
                setRequestedMainAlias(nextAlias);
                const url = new URL(window.location.href);
                url.searchParams.set("mainAlias", nextAlias);
                window.history.replaceState({}, "", url);
              }}
            >
              {runtimeData.databases.map((database) => (
                <option key={database.alias} value={database.alias} className="bg-slate-950">
                  {database.alias} - {database.title ?? database.host ?? database.path}
                </option>
              ))}
            </select>
          </div>
          <iframe
            ref={iframeRef}
            title="Embedded Outerbase"
            src={runtimeData.studioSrc}
            className="min-h-0 flex-1 border-0 bg-slate-950"
          />
        </div>
      ) : null}
    </div>
  );
}
