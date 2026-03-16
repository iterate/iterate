import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BookOpenText } from "lucide-react";
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
import { Button } from "@iterate-com/ui/components/button";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/docs")({
  ssr: false,
  component: DocsPage,
});

function DocsPage() {
  const { data, isPending } = useQuery(orpc.docs.listSources.queryOptions());
  const sources = data?.sources ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Documentation sources</CardTitle>
          <CardDescription>
            Registry-discovered OpenAPI surfaces, ready to feed Scalar or external tooling.
          </CardDescription>
        </CardHeader>
      </Card>

      {isPending ? <p className="text-sm text-muted-foreground">Loading docs sources...</p> : null}

      {sources.length === 0 && !isPending ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpenText className="size-5" />
            </EmptyMedia>
            <EmptyTitle>No docs sources</EmptyTitle>
            <EmptyDescription>
              Tag a route with `openapi` and an `openapiPath` metadata value.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {sources.map((source) => (
          <Card key={source.id} className="border-zinc-200/80">
            <CardHeader>
              <CardTitle>{source.title}</CardTitle>
              <CardDescription>{source.id}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg bg-muted/60 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Service URL
                </p>
                <p className="mt-1 break-all font-mono text-xs">{source.serviceUrl}</p>
              </div>
              <div className="rounded-lg bg-muted/60 p-3">
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Spec URL
                </p>
                <p className="mt-1 break-all font-mono text-xs">{source.specUrl}</p>
              </div>
              <div className="flex gap-2">
                <Button asChild size="sm">
                  <a href={source.specUrl} target="_blank" rel="noreferrer">
                    Open spec
                    <ArrowUpRight className="size-4" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href={source.serviceUrl} target="_blank" rel="noreferrer">
                    Open service
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Registry API</CardTitle>
          <CardDescription>
            The registry itself still exposes its own OpenAPI and Scalar docs under `/api`.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/routes">Back to routes</Link>
          </Button>
          <Button asChild>
            <a href="/api/docs" target="_blank" rel="noreferrer">
              Open registry docs
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
