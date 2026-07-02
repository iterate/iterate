import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { toast } from "@iterate-com/ui/components/sonner";
import { orpcClient } from "../../utils/query.tsx";
import { organizationsQueryOptions } from "../../utils/auth-query-options.ts";
import {
  DeleteOrganizationDialog,
  DeleteProjectDialog,
  inventoryQueryOptions,
  OrganizationDetail,
  OrganizationDialog,
  OrganizationRail,
  ProjectDialog,
  type InventoryOrganization,
  type Project,
} from "./-projects-shared.tsx";

// The deep-linkable organization management page: which organization is being
// managed lives in the URL, not in component state.
export const Route = createFileRoute("/_auth/projects/$organizationSlug")({
  component: OrganizationInventoryPage,
});

function OrganizationInventoryPage() {
  const { organizationSlug } = Route.useParams();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ organizationSlug: string } | null>(null);
  const [deleteOrganization, setDeleteOrganization] = useState<InventoryOrganization | null>(null);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);

  const inventoryQuery = useQuery(inventoryQueryOptions());
  const organizations = inventoryQuery.data ?? [];
  const selectedOrganization =
    organizations.find((organization) => organization.slug === organizationSlug) ?? null;

  const refreshInventory = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: inventoryQueryOptions().queryKey }),
      queryClient.invalidateQueries({ queryKey: organizationsQueryOptions().queryKey }),
    ]);
  };

  const createOrganization = useMutation({
    mutationFn: (input: { name: string }) => orpcClient.organization.create(input),
    onSuccess: async (organization) => {
      toast.success("Organization created");
      setOrganizationDialogOpen(false);
      await refreshInventory();
      await navigate({
        to: "/projects/$organizationSlug",
        params: { organizationSlug: organization.slug },
      });
    },
    onError: (error) => toast.error(error.message),
  });

  const removeOrganization = useMutation({
    mutationFn: (slug: string) => orpcClient.organization.delete({ organizationSlug: slug }),
    onSuccess: async () => {
      toast.success("Organization deleted");
      setDeleteOrganization(null);
      await refreshInventory();
      // The organization in the URL may be gone — let the index pick again.
      await navigate({ to: "/projects" });
    },
    onError: (error) => toast.error(error.message),
  });

  const createProject = useMutation({
    mutationFn: (input: { name: string; organizationSlug: string }) =>
      orpcClient.project.create(input),
    onSuccess: async (project) => {
      toast.success("Project created");
      setProjectDialog(null);
      await refreshInventory();
      const owningOrganization = organizations.find(
        (organization) => organization.id === project.organizationId,
      );
      if (owningOrganization && owningOrganization.slug !== organizationSlug) {
        await navigate({
          to: "/projects/$organizationSlug",
          params: { organizationSlug: owningOrganization.slug },
        });
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const removeProject = useMutation({
    mutationFn: (projectSlug: string) => orpcClient.project.delete({ projectSlug }),
    onSuccess: async () => {
      toast.success("Project deleted");
      setDeleteProject(null);
      await refreshInventory();
    },
    onError: (error) => toast.error(error.message),
  });

  // Unknown or no-longer-visible organization slug: fall back to the index,
  // which redirects to the first organization or the empty state.
  if (inventoryQuery.isSuccess && !selectedOrganization) {
    return <Navigate to="/projects" replace />;
  }

  return (
    <main className="min-h-screen bg-background">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight">Organizations</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Manage organizations and their projects.
            </p>
          </div>
          <Button onClick={() => setOrganizationDialogOpen(true)}>New organization</Button>
        </header>

        {inventoryQuery.isPending ? (
          <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="h-96 rounded-lg border bg-muted/30" />
            <div className="h-96 rounded-lg border bg-muted/30" />
          </div>
        ) : inventoryQuery.isError ? (
          <Empty className="min-h-[420px] border">
            <EmptyHeader>
              <EmptyTitle>Could not load organizations</EmptyTitle>
              <EmptyDescription>{inventoryQuery.error.message}</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => inventoryQuery.refetch()}>
              Try again
            </Button>
          </Empty>
        ) : selectedOrganization ? (
          <div className="grid min-h-[520px] gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <OrganizationRail
              organizations={organizations}
              selectedOrganizationSlug={selectedOrganization.slug}
            />
            <OrganizationDetail
              organization={selectedOrganization}
              canManage={
                selectedOrganization.role === "owner" || selectedOrganization.role === "admin"
              }
              onCreateProject={() =>
                setProjectDialog({
                  organizationSlug: selectedOrganization.slug,
                })
              }
              onDeleteOrganization={() => setDeleteOrganization(selectedOrganization)}
              onDeleteProject={setDeleteProject}
            />
          </div>
        ) : null}
      </section>

      <OrganizationDialog
        open={organizationDialogOpen}
        isPending={createOrganization.isPending}
        onOpenChange={setOrganizationDialogOpen}
        onSubmit={(input) => createOrganization.mutate(input)}
      />

      <ProjectDialog
        state={projectDialog}
        organizations={organizations}
        isPending={createProject.isPending}
        onOpenChange={(open) => !open && setProjectDialog(null)}
        onSubmit={(input) => createProject.mutate(input)}
      />

      <DeleteOrganizationDialog
        organization={deleteOrganization}
        isPending={removeOrganization.isPending}
        onOpenChange={(open) => !open && setDeleteOrganization(null)}
        onConfirm={() => {
          if (deleteOrganization) removeOrganization.mutate(deleteOrganization.slug);
        }}
      />

      <DeleteProjectDialog
        project={deleteProject}
        isPending={removeProject.isPending}
        onOpenChange={(open) => !open && setDeleteProject(null)}
        onConfirm={() => {
          if (deleteProject) removeProject.mutate(deleteProject.slug);
        }}
      />
    </main>
  );
}
