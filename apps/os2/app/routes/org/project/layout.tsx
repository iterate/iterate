import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/$projectSlug")({
  component: ProjectLayout,
});

function ProjectLayout() {
  return <Outlet />;
}
