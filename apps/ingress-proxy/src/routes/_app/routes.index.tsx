import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/routes/")({
  component: RoutesIndexPage,
  staticData: {
    breadcrumb: "All",
  },
});

function RoutesIndexPage() {
  const { data } = useQuery({
    ...orpc.routes.list.queryOptions({ input: { limit: 100, offset: 0 } }),
    staleTime: 15_000,
  });

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Public read-only view of the current ingress registry. Mutations stay behind the bearer
        token, but listing and inspection are intentionally open here.
      </p>

      <div className="space-y-3">
        {data?.routes.map((route) => (
          <a
            key={route.id}
            href={`/routes/${encodeURIComponent(route.rootHost)}/`}
            className="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/30"
          >
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{route.rootHost}</p>
                <p className="truncate text-sm text-muted-foreground">{route.targetUrl}</p>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{route.id}</span>
                <span>{Object.keys(route.metadata).length} metadata fields</span>
              </div>
            </div>
          </a>
        ))}
      </div>

      {data && data.routes.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          No ingress routes are currently registered.
        </p>
      ) : null}
    </section>
  );
}
