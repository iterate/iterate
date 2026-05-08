import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/counters")({
  staticData: {
    breadcrumb: "Durable Objects",
    breadcrumbTo: "/durable-objects",
  },
  component: CountersLayout,
});

function CountersLayout() {
  return <Outlet />;
}
