import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/routes/$slug")({
  component: ServiceRouteLayout,
});

function ServiceRouteLayout() {
  return <Outlet />;
}
