import { Outlet, createFileRoute } from "@tanstack/react-router";
import { breadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams")({
  staticData: breadcrumbStaticData("/streams"),
  component: StreamsLayout,
});

function StreamsLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </div>
  );
}
