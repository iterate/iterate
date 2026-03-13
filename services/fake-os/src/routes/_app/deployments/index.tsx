import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ServerIcon, PlusIcon } from "lucide-react";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { orpc } from "@/lib/orpc.ts";

export const Route = createFileRoute("/_app/deployments/")({
  component: DeploymentsIndex,
});

function DeploymentsIndex() {
  const { data: deployments = [] } = useQuery(orpc.deployments.list.queryOptions());

  return (
    <div className="mx-auto max-w-md">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Deployments</h1>
        <Link
          to="/deployments/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          <PlusIcon className="size-4" />
          New
        </Link>
      </div>

      {deployments.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-8 text-center">
          <ServerIcon className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">No deployments yet</p>
          <Link
            to="/deployments/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <PlusIcon className="size-4" />
            Create your first deployment
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {deployments.map((d) => (
            <li key={d.id}>
              <Link
                to="/deployments/$slug"
                params={{ slug: d.slug }}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:bg-accent transition-colors"
              >
                <ServerIcon className="size-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <Identifier value={d.slug} className="max-w-full" />
                  <div className="text-xs text-muted-foreground">{d.provider}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
