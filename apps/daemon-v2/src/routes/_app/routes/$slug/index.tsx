import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@iterate-com/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@iterate-com/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import {
  fetchLandingData,
  getDbSourceForRoute,
  getDocsSourceForRoute,
  getRouteBySlug,
  type LandingDataResponse,
} from "~/lib/landing.ts";

export const Route = createFileRoute("/_app/routes/$slug/")({
  component: AppOverviewPage,
});

function AppOverviewPage() {
  const { slug } = Route.useParams();
  const { data } = useQuery<LandingDataResponse>({
    queryKey: ["registry", "landing"],
    queryFn: fetchLandingData,
  });

  const route = getRouteBySlug(data, slug);
  const docsSource = route ? getDocsSourceForRoute(data, route) : undefined;
  const dbSource = route ? getDbSourceForRoute(data, route) : undefined;

  if (!route) {
    return (
      <Empty className="mx-auto max-w-3xl">
        <EmptyHeader>
          <EmptyTitle>App not found</EmptyTitle>
          <EmptyDescription>No registry app matched `{slug}`.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-base">{route.host}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailRow label="Public URL" value={route.publicURL} mono />
          <DetailRow label="Target" value={route.target} mono />
          <DetailRow label="Updated" value={formatDate(route.updatedAt)} />

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Capabilities</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant={docsSource ? "secondary" : "outline"}>Openapi docs</Badge>
              <Badge variant={dbSource ? "secondary" : "outline"}>DB</Badge>
              {route.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Metadata</p>
            <pre className="overflow-x-auto rounded-lg border bg-card p-3 text-xs font-mono">
              {JSON.stringify(route.metadata, null, 2)}
            </pre>
          </div>

          {route.caddyDirectives.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Caddy directives</p>
              <pre className="overflow-x-auto rounded-lg border bg-card p-3 text-xs font-mono">
                {route.caddyDirectives.join("\n")}
              </pre>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function DetailRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-muted-foreground">{props.label}</p>
      <p className={props.mono ? "font-mono text-sm" : "text-sm"}>{props.value}</p>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
