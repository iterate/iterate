import { createFileRoute } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { EmptyState } from "../../../components/empty-state.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/projects/$projectSlug/agents")({
  component: ProjectAgentsPage,
});

function ProjectAgentsPage() {
  return (
    <div className="p-4 md:p-8">
      <EmptyState
        icon={<Bot className="h-12 w-12" />}
        title="No agents yet"
        description="Agent workflows will appear here."
      />
    </div>
  );
}
