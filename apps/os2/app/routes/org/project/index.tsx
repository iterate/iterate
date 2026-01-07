import { createFileRoute } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "../../../components/empty-state.tsx";

export const Route = createFileRoute(
  "/_auth-required.layout/_/orgs/$organizationSlug/_/projects/$projectSlug/",
)({
  component: ProjectAccessTokensPage,
});

function ProjectAccessTokensPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Access tokens</h1>
      <div className="mt-6">
        <EmptyState
          icon={<KeyRound className="h-12 w-12" />}
          title="No access tokens"
          description="Create tokens to access this project programmatically."
          action={{
            label: "Create token",
            onClick: () => toast("Access tokens are coming soon."),
          }}
        />
      </div>
    </div>
  );
}
