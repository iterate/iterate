import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/routes")({
  staticData: {
    breadcrumb: "Routes",
  },
  component: RoutesLayout,
});

function RoutesLayout() {
  return <Outlet />;
}
