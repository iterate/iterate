import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/")({
  component: OrganizationIndexPage,
});

function OrganizationIndexPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold">No Projects</h1>
        <p className="text-muted-foreground">Create your first project to get started.</p>
      </div>
    </div>
  );
}
