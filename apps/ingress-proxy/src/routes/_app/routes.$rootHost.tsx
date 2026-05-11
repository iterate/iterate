import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/routes/$rootHost")({
  component: RouteDetailPage,
  loader: ({ params }) => ({ breadcrumb: params.rootHost }),
});

function RouteDetailPage() {
  const { rootHost } = Route.useParams();
  const { data } = useQuery({
    ...orpc.routes.get.queryOptions({ input: { rootHost } }),
    staleTime: 15_000,
  });

  if (!data) {
    return null;
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Root host</dt>
            <dd className="mt-1 break-all font-medium">{data.rootHost}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Target URL</dt>
            <dd className="mt-1 break-all">{data.targetUrl}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
            <dd className="mt-1">{data.createdAt}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Updated</dt>
            <dd className="mt-1">{data.updatedAt}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">ID</dt>
            <dd className="mt-1 break-all text-muted-foreground">{data.id}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Metadata</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(data.metadata, null, 2)}
        </pre>
      </div>
    </section>
  );
}
