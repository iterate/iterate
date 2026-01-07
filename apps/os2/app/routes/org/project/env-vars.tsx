import { createFileRoute } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "../../../components/empty-state.tsx";

export const Route = createFileRoute(
  "/_auth-required.layout/_/orgs/$organizationSlug/_/projects/$projectSlug/env-vars",
)({
  component: ProjectEnvVarsPage,
});

function ProjectEnvVarsPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Environment variables</h1>
      <div className="mt-6">
        <EmptyState
          icon={<SlidersHorizontal className="h-12 w-12" />}
          title="No env vars"
          description="Store project secrets and configuration here."
          action={{
            label: "Add env var",
            onClick: () => toast("Env vars are coming soon."),
          }}
        />
      </div>
    </div>
  );
}
