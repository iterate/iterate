import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/things")({
  staticData: {
    breadcrumb: "Things",
  },
  component: ThingsLayout,
});

function ThingsLayout() {
  return <Outlet />;
}
