import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/resources/")({
  component: ResourcesIndexPage,
  staticData: {
    breadcrumb: "All",
  },
});

function ResourcesIndexPage() {
  const { data } = useQuery({
    ...orpc.resources.list.queryOptions({ input: {} }),
    staleTime: 15_000,
  });

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Unauthenticated inventory view of the semaphore database. Lease mutations still require the
        bearer token; the dashboard only shows current state.
      </p>

      <div className="space-y-3">
        {data?.map((resource) => (
          <a
            key={`${resource.type}:${resource.slug}`}
            href={`/resources/${encodeURIComponent(resource.type)}/${encodeURIComponent(resource.slug)}/`}
            className="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/30"
          >
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{resource.slug}</p>
                  <p className="truncate text-sm text-muted-foreground">{resource.type}</p>
                </div>
                <div className="shrink-0 text-xs text-muted-foreground">{resource.leaseState}</div>
              </div>
              <p className="text-xs text-muted-foreground">
                {resource.leasedUntil
                  ? `leased until ${new Date(resource.leasedUntil).toISOString()}`
                  : "available now"}
              </p>
            </div>
          </a>
        ))}
      </div>

      {data && data.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          No resources are currently registered.
        </p>
      ) : null}
    </section>
  );
}
