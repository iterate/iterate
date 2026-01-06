import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc.ts";

export const Route = createFileRoute("/_auth.layout/$organizationSlug")({
  component: OrgLayout,
});

function OrgLayout() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();

  const { data: organization } = useSuspenseQuery(
    trpc.organization.get.queryOptions({ organizationSlug }),
  );

  const { data: instances } = useSuspenseQuery(
    trpc.instance.list.queryOptions({ organizationSlug }),
  );

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r bg-muted/40 p-4">
        <div className="mb-6">
          <h2 className="font-semibold text-lg">{organization.name}</h2>
        </div>

        <nav className="space-y-2">
          <div className="text-sm font-medium text-muted-foreground mb-2">Instances</div>
          {instances.map((instance) => (
            <Link
              key={instance.id}
              to="/$organizationSlug/$instanceSlug"
              params={{ organizationSlug, instanceSlug: instance.slug }}
              className="block px-2 py-1.5 rounded-md hover:bg-accent"
              activeProps={{ className: "bg-accent" }}
            >
              {instance.name}
            </Link>
          ))}

          {instances.length === 0 && (
            <p className="text-sm text-muted-foreground px-2">No instances yet</p>
          )}

          <div className="pt-4 mt-4 border-t">
            <div className="text-sm font-medium text-muted-foreground mb-2">Organization</div>
            <Link
              to="/$organizationSlug/settings"
              params={{ organizationSlug }}
              className="block px-2 py-1.5 rounded-md hover:bg-accent"
              activeProps={{ className: "bg-accent" }}
            >
              Settings
            </Link>
            <Link
              to="/$organizationSlug/team"
              params={{ organizationSlug }}
              className="block px-2 py-1.5 rounded-md hover:bg-accent"
              activeProps={{ className: "bg-accent" }}
            >
              Team
            </Link>
            <Link
              to="/$organizationSlug/connectors"
              params={{ organizationSlug }}
              className="block px-2 py-1.5 rounded-md hover:bg-accent"
              activeProps={{ className: "bg-accent" }}
            >
              Connectors
            </Link>
          </div>
        </nav>
      </aside>

      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
