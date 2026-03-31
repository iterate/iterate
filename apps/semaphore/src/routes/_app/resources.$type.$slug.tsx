import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/resources/$type/$slug")({
  component: ResourceDetailPage,
  loader: ({ params }) => ({ breadcrumb: `${params.type}/${params.slug}` }),
});

function ResourceDetailPage() {
  const { type, slug } = Route.useParams();
  const { data } = useQuery({
    ...orpc.resources.find.queryOptions({ input: { type, slug } }),
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
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Type</dt>
            <dd className="mt-1">{data.type}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Slug</dt>
            <dd className="mt-1">{data.slug}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Lease state</dt>
            <dd className="mt-1">{data.leaseState}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Leased until</dt>
            <dd className="mt-1">
              {data.leasedUntil ? new Date(data.leasedUntil).toISOString() : "Not leased"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
            <dd className="mt-1">{data.createdAt}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Updated</dt>
            <dd className="mt-1">{data.updatedAt}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Data</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(data.data, null, 2)}
        </pre>
      </div>
    </section>
  );
}
