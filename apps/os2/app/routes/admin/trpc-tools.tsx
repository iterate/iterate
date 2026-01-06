import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/admin/trpc-tools")({
  component: TrpcToolsPage,
});

function TrpcToolsPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">tRPC Tools</h1>
    </div>
  );
}
