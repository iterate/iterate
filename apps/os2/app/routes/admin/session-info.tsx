import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/admin/session-info")({
  component: SessionInfoPage,
});

function SessionInfoPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Session Info</h1>
    </div>
  );
}
