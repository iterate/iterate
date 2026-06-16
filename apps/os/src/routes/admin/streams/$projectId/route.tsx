import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/streams/$projectId")({
  component: AdminStreamProjectLayout,
});

function AdminStreamProjectLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </div>
  );
}
