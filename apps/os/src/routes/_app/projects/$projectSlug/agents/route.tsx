import { Outlet, createFileRoute } from "@tanstack/react-router";
import { breadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents")({
  staticData: breadcrumbStaticData("Agents"),
  component: AgentsLayout,
});

function AgentsLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </div>
  );
}
