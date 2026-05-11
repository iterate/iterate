import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/streams")({
  staticData: {
    breadcrumb: "Streams",
  },
  component: StreamsLayout,
});

function StreamsLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </div>
  );
}
