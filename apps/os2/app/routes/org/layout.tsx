import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/$organizationSlug")({
  component: OrganizationLayout,
});

function OrganizationLayout() {
  return (
    <div className="flex min-h-screen">
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );
}
