import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/streams/$namespace")({
  component: AdminStreamNamespaceLayout,
});

function AdminStreamNamespaceLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </div>
  );
}
