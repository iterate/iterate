import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/connectors")({
  component: ConnectorsPage,
});

function ConnectorsPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Connectors</h1>
    </div>
  );
}
