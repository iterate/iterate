import { createFileRoute } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { EmptyState } from "../../../components/empty-state.tsx";

export const Route = createFileRoute(
  "/_auth-required/_/orgs/$organizationSlug/_/projects/$projectSlug/agents",
)({
  component: ProjectAgentsPage,
});

function ProjectAgentsPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Agents</h1>
      <div className="mt-6">
        <EmptyState
          icon={<Bot className="h-12 w-12" />}
          title="No agents yet"
          description="Agent workflows will appear here."
        />
      </div>
    </div>
  );
}
