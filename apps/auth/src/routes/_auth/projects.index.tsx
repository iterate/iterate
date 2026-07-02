import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { toast } from "@iterate-com/ui/components/sonner";
import { orpcClient } from "../../utils/query.tsx";
import { organizationsQueryOptions } from "../../utils/auth-query-options.ts";
import { inventoryQueryOptions, OrganizationDialog } from "./-projects-shared.tsx";

// /projects has no selection of its own: it forwards to the first
// organization's page (/projects/$organizationSlug — the deep-linkable unit)
// or shows the create-your-first-organization empty state.
export const Route = createFileRoute("/_auth/projects/")({
  component: ProjectsIndexPage,
});

function ProjectsIndexPage() {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const [organizationDialogOpen, setOrganizationDialogOpen] = useState(false);

  const inventoryQuery = useQuery(inventoryQueryOptions());

  const createOrganization = useMutation({
    mutationFn: (input: { name: string }) => orpcClient.organization.create(input),
    onSuccess: async (organization) => {
      toast.success("Organization created");
      setOrganizationDialogOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: organizationsQueryOptions().queryKey }),
      ]);
      await navigate({
        to: "/projects/$organizationSlug",
        params: { organizationSlug: organization.slug },
      });
    },
    onError: (error) => toast.error(error.message),
  });

  if (inventoryQuery.isPending) {
    return (
      <main className="min-h-screen bg-background">
        <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="h-96 rounded-lg border bg-muted/30" />
        </section>
      </main>
    );
  }

  if (inventoryQuery.isError) {
    return (
      <main className="min-h-screen bg-background">
        <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <Empty className="min-h-[420px] border">
            <EmptyHeader>
              <EmptyTitle>Could not load organizations</EmptyTitle>
              <EmptyDescription>{inventoryQuery.error.message}</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => inventoryQuery.refetch()}>
              Try again
            </Button>
          </Empty>
        </section>
      </main>
    );
  }

  const firstOrganization = inventoryQuery.data[0];
  if (firstOrganization) {
    return (
      <Navigate
        to="/projects/$organizationSlug"
        params={{ organizationSlug: firstOrganization.slug }}
        replace
      />
    );
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
        <Empty className="min-h-[460px] border">
          <EmptyHeader>
            <EmptyTitle>Create your first organization</EmptyTitle>
            <EmptyDescription>
              Start with the company or team name people expect to see.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setOrganizationDialogOpen(true)}>Create organization</Button>
        </Empty>
      </section>

      <OrganizationDialog
        open={organizationDialogOpen}
        isPending={createOrganization.isPending}
        onOpenChange={setOrganizationDialogOpen}
        onSubmit={(input) => createOrganization.mutate(input)}
      />
    </main>
  );
}
