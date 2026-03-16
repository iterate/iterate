import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Database, Play } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/db")({
  ssr: false,
  component: DbPage,
});

function DbPage() {
  const [mainAlias, setMainAlias] = useState("");
  const [statement, setStatement] = useState("select name from sqlite_master order by name;");

  const { data: sourcesData } = useQuery(orpc.db.listSources.queryOptions());
  const { data: runtimeData, isPending: runtimePending } = useQuery(
    orpc.db.runtime.queryOptions({
      input: {
        ...(mainAlias.trim() ? { mainAlias: mainAlias.trim() } : {}),
      },
    }),
  );

  const queryMutation = useMutation(orpc.db.query.mutationOptions());
  const sources = sourcesData?.sources ?? [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>SQLite browser</CardTitle>
          <CardDescription>
            Discover registry-tagged sqlite databases and run read-only style inspection queries
            through the oRPC surface.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Discovered databases</CardTitle>
              <CardDescription>
                {String(sources.length)} sqlite targets tagged through registry metadata.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {sources.length === 0 ? (
                <Empty>
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
              ) : (
                sources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className="w-full rounded-xl border p-4 text-left transition hover:bg-muted/50"
                    onClick={() => setMainAlias(source.sqliteAlias)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{source.title}</p>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {source.sqliteAlias}
                        </p>
                      </div>
                      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        {source.host}
                      </p>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {source.sqlitePath}
                    </p>
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runtime attachment</CardTitle>
              <CardDescription>
                {runtimePending
                  ? "Resolving attached databases..."
                  : `Main alias: ${runtimeData?.selectedMainAlias ?? "n/a"}`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field>
                <FieldLabel htmlFor="main-alias">Main alias</FieldLabel>
                <FieldContent>
                  <Input
                    id="main-alias"
                    value={mainAlias}
                    onChange={(event) => setMainAlias(event.target.value)}
                    placeholder={runtimeData?.selectedMainAlias ?? "main"}
                  />
                  <FieldDescription>
                    Leave blank to let the registry choose the first discovered alias.
                  </FieldDescription>
                </FieldContent>
              </Field>

              <div className="rounded-lg bg-muted/60 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Studio source
                </p>
                <p className="mt-1 break-all font-mono text-xs">
                  {runtimeData?.studioSrc ?? "unavailable"}
                </p>
              </div>

              <div className="space-y-2">
                {(runtimeData?.databases ?? []).map((db) => (
                  <div key={db.alias} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium">{db.alias}</p>
                      <p className="text-xs text-muted-foreground">
                        {db.title ?? db.host ?? "sqlite"}
                      </p>
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {db.path}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Query runner</CardTitle>
            <CardDescription>
              Send one SQL statement through `registry.db.query` and inspect the transformed result.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field>
              <FieldLabel htmlFor="sql-statement">SQL statement</FieldLabel>
              <FieldContent>
                <Textarea
                  id="sql-statement"
                  className="min-h-48 font-mono text-xs"
                  value={statement}
                  onChange={(event) => setStatement(event.target.value)}
                />
              </FieldContent>
            </Field>

            <Button
              onClick={() =>
                queryMutation.mutate({
                  ...(mainAlias.trim() ? { mainAlias: mainAlias.trim() } : {}),
                  request: { type: "query", id: Date.now(), statement },
                })
              }
              disabled={queryMutation.isPending || statement.trim().length === 0}
            >
              <Play className="size-4" />
              {queryMutation.isPending ? "Running query..." : "Run query"}
            </Button>

            <div className="rounded-xl bg-zinc-950 p-4 text-zinc-50">
              <p className="mb-3 text-xs uppercase tracking-[0.18em] text-zinc-400">Result</p>
              <pre className="overflow-x-auto text-xs leading-6 whitespace-pre-wrap">
                {JSON.stringify(queryMutation.data ?? { status: "idle" }, null, 2)}
              </pre>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
