import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/runs")({
  staticData: {
    breadcrumb: "Runs",
  },
  component: RunsLayout,
});

function RunsLayout() {
  return <Outlet />;
}
