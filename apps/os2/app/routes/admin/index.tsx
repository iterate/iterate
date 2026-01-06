import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/admin/")({
  component: AdminIndexPage,
});

function AdminIndexPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Admin</h1>
    </div>
  );
}
