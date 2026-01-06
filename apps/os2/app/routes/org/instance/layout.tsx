import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "../../../lib/trpc.ts";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/$instanceSlug")({
  component: InstanceLayout,
});

function InstanceLayout() {
  const { organizationSlug, instanceSlug } = Route.useParams();
  const trpc = useTRPC();

  const { data: instance } = useSuspenseQuery(
    trpc.instance.get.queryOptions({ organizationSlug, instanceSlug }),
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{instance.name}</h1>
      </div>
      <Outlet />
    </div>
  );
}
