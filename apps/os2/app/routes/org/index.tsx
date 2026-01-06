import { createFileRoute, Navigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Folder } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "../../lib/trpc.ts";
import { EmptyState } from "../../components/empty-state.tsx";

export const Route = createFileRoute("/_auth-required.layout/_/$organizationSlug/")({
  component: OrgIndexPage,
});

function OrgIndexPage() {
  const params = useParams({ from: "/_auth-required.layout/_/$organizationSlug/" });

  const { data: projects, isLoading } = useQuery(
    trpc.instance.list.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (projects && projects.length > 0) {
    return (
      <Navigate
        to="/$organizationSlug/$projectSlug"
        params={{
          organizationSlug: params.organizationSlug,
          projectSlug: projects[0].slug,
        }}
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<Folder className="h-12 w-12" />}
        title="No projects yet"
        description="Create your first project to get started."
        action={{
          label: "Create Project",
          onClick: () => toast("Project creation is coming next."),
        }}
      />
    </div>
  );
}
