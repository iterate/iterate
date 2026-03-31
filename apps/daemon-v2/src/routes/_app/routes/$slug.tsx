import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/routes/$slug")({
  loader: ({ params }) => ({
    breadcrumb: params.slug,
  }),
  component: AppRouteLayout,
});

function AppRouteLayout() {
  return <Outlet />;
}
