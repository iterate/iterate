import { Outlet, createFileRoute } from "@tanstack/react-router";

// No breadcrumb here: every child page publishes a streamBreadcrumb whose
// path ancestry replaces route crumbs entirely.
export const Route = createFileRoute("/_app/projects/$projectSlug/streams")({
  component: StreamsLayout,
});

function StreamsLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </div>
  );
}
