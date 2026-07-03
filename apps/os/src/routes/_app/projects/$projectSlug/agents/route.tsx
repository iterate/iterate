import { Outlet, createFileRoute } from "@tanstack/react-router";

// No breadcrumb here: every child page publishes a streamBreadcrumb whose
// path ancestry already includes /agents.
export const Route = createFileRoute("/_app/projects/$projectSlug/agents")({
  component: AgentsLayout,
});

function AgentsLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </div>
  );
}
