import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Plus, Trash2 } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
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
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { fetchLandingData, type LandingDataResponse } from "@/lib/landing.ts";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/routes/")({
  ssr: false,
  component: RoutesPage,
});

function RoutesPage() {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery<LandingDataResponse>({
    queryKey: ["registry", "landing"],
    queryFn: fetchLandingData,
  });
  const [host, setHost] = useState("");
  const [target, setTarget] = useState("");
  const [tags, setTags] = useState("");
  const [metadataJson, setMetadataJson] = useState("{}");
  const [caddyDirectives, setCaddyDirectives] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["registry", "landing"] }),
      queryClient.invalidateQueries({ queryKey: orpc.routes.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.docs.listSources.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.db.listSources.key() }),
    ]);
  };

  const upsertMutation = useMutation(
    orpc.routes.upsert.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        setHost("");
        setTarget("");
        setTags("");
        setMetadataJson("{}");
        setCaddyDirectives("");
        setFormError(null);
      },
    }),
  );

  const removeMutation = useMutation(
    orpc.routes.remove.mutationOptions({
      onSuccess: async () => {
        await invalidate();
      },
    }),
  );

  const routes = data?.routes ?? [];

  const handleSubmit = () => {
    try {
      const parsedMetadata = parseMetadata(metadataJson);
      upsertMutation.mutate({
        host: host.trim(),
        target: target.trim(),
        metadata: parsedMetadata,
        tags: parseLinesOrCsv(tags),
        caddyDirectives: parseLines(caddyDirectives),
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <Card className="overflow-hidden border-none bg-linear-to-br from-zinc-950 via-zinc-900 to-zinc-800 text-zinc-50 shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">Ingress registry</CardTitle>
          <CardDescription className="text-zinc-300">
            One crisp control plane for routes, docs, sqlite discovery, and Caddy metadata.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Metric label="Ingress host" value={data?.ingress.ITERATE_INGRESS_HOST ?? "unset"} />
          <Metric
            label="Routing type"
            value={data?.ingress.ITERATE_INGRESS_ROUTING_TYPE ?? "unknown"}
          />
          <Metric
            label="Default service"
            value={data?.ingress.ITERATE_INGRESS_DEFAULT_SERVICE ?? "unset"}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_1.4fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="size-4" />
              Upsert route
            </CardTitle>
            <CardDescription>
              Register a host, target, tags, metadata, and optional Caddy directives.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field>
              <FieldLabel htmlFor="host">Host</FieldLabel>
              <FieldContent>
                <Input
                  id="host"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="registry.iterate.localhost"
                />
                <FieldDescription>
                  Canonical internal host that this route should answer for.
                </FieldDescription>
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel htmlFor="target">Target</FieldLabel>
              <FieldContent>
                <Input
                  id="target"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder="127.0.0.1:17310"
                />
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel htmlFor="tags">Tags</FieldLabel>
              <FieldContent>
                <Input
                  id="tags"
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="openapi, sqlite"
                />
                <FieldDescription>Comma or newline separated.</FieldDescription>
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel htmlFor="metadata-json">Metadata JSON</FieldLabel>
              <FieldContent>
                <Textarea
                  id="metadata-json"
                  className="min-h-32 font-mono text-xs"
                  value={metadataJson}
                  onChange={(event) => setMetadataJson(event.target.value)}
                />
                <FieldDescription>
                  Values must be strings because the contract stores a string-to-string map.
                </FieldDescription>
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel htmlFor="caddy-directives">Caddy directives</FieldLabel>
              <FieldContent>
                <Textarea
                  id="caddy-directives"
                  className="min-h-24 font-mono text-xs"
                  value={caddyDirectives}
                  onChange={(event) => setCaddyDirectives(event.target.value)}
                  placeholder="header_up Authorization {env.OPENOBSERVE_AUTH}"
                />
                <FieldDescription>One directive per line.</FieldDescription>
              </FieldContent>
            </Field>

            {formError ? <p className="text-sm text-destructive">{formError}</p> : null}

            <Button
              className="w-full"
              onClick={handleSubmit}
              disabled={
                upsertMutation.isPending || host.trim().length === 0 || target.trim().length === 0
              }
            >
              {upsertMutation.isPending ? "Saving route..." : "Save route"}
            </Button>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Registered routes</CardTitle>
              <CardDescription>
                {isPending
                  ? "Loading..."
                  : `${String(routes.length)} routes synchronized through the registry.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {routes.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Globe className="size-5" />
                    </EmptyMedia>
                    <EmptyTitle>No routes yet</EmptyTitle>
                    <EmptyDescription>Add the first route to seed the registry.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                routes.map((route) => (
                  <div
                    key={route.host}
                    id={route.host}
                    className="scroll-mt-4 rounded-xl border bg-card/60 p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        <Identifier value={route.host} textClassName="text-sm font-semibold" />
                        <p className="font-mono text-xs text-muted-foreground">{route.publicURL}</p>
                        <p className="font-mono text-xs text-muted-foreground">{route.target}</p>
                        <div className="flex flex-wrap gap-2">
                          {route.tags.map((tag) => (
                            <Badge key={tag} variant="secondary">
                              {tag}
                            </Badge>
                          ))}
                          {route.tags.length === 0 ? (
                            <Badge variant="outline">untagged</Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          updated {formatDate(route.updatedAt)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeMutation.mutate({ host: route.host })}
                        disabled={removeMutation.isPending}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Docs sources</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(data?.docsSources ?? []).slice(0, 4).map((source) => (
                  <div key={source.id} className="space-y-1 rounded-lg border p-3">
                    <p className="font-medium">{source.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{source.specUrl}</p>
                  </div>
                ))}
                {(data?.docsSources?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No OpenAPI sources discovered.</p>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>DB sources</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(data?.dbSources ?? []).slice(0, 4).map((source) => (
                  <div key={source.id} className="space-y-1 rounded-lg border p-3">
                    <p className="font-medium">{source.title}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {source.sqlitePath}
                    </p>
                  </div>
                ))}
                {(data?.dbSources?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No sqlite databases discovered.</p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-zinc-400">{props.label}</p>
      <p className="mt-2 font-mono text-sm text-zinc-50">{props.value}</p>
    </div>
  );
}

function parseLines(value: string) {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseLinesOrCsv(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseMetadata(value: string) {
  const parsed = JSON.parse(value || "{}") as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      out[key] = entry;
      continue;
    }
    throw new Error(`Metadata entry "${key}" must be a string.`);
  }
  return out;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
