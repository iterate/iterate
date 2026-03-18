import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/caddy")({
  ssr: false,
  component: CaddyPage,
});

function CaddyPage() {
  const { data: routesData } = useQuery(orpc.routes.list.queryOptions());

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Caddy integration</CardTitle>
          <CardDescription>
            Registry no longer talks to the Caddy admin API. If `SYNC_TO_CADDY_PATH` is set, route
            changes write a fragment file and Caddy reloads it via `caddy run --watch`.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Metric label="Registered routes" value={String(routesData?.total ?? 0)} />
          <Metric label="Integration mode" value="Optional fragment write via SYNC_TO_CADDY_PATH" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How it works</CardTitle>
          <CardDescription>
            The registry stays a normal Node service unless you opt into file output.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>`startup.initialize` always seeds the registry-owned default routes.</p>
          <p>
            Bootstrap control-plane routes live in `builtin-handlers.caddy`, not in the dynamic
            fragment.
          </p>
          <p>
            When `SYNC_TO_CADDY_PATH` is unset, route changes only update the registry database.
          </p>
          <p>
            When `SYNC_TO_CADDY_PATH` is set, route changes also rewrite the fragment file at that
            path.
          </p>
          <p>
            Caddy should be started separately with `--watch` so it notices fragment updates on its
            own.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/40 p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{props.label}</p>
      <p className="mt-2 font-mono text-sm">{props.value}</p>
    </div>
  );
}
