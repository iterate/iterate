import { useState, type FormEvent } from "react";
import { createFileRoute, useParams, useNavigate } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";

type ProjectSandboxProvider = "daytona" | "docker" | "fly";

const SANDBOX_PROVIDER_LABELS: Record<ProjectSandboxProvider, string> = {
  daytona: "Daytona (Cloud)",
  docker: "Docker",
  fly: "Fly.io",
};

export const Route = createFileRoute("/_auth/proj/$projectSlug/settings")({
  component: ProjectSettingsPage,
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(trpc.project.getAvailableSandboxProviders.queryOptions());
  },
});

function ProjectSettingsPage() {
  const params = useParams({
    from: "/_auth/proj/$projectSlug/settings",
  });
  const navigate = useNavigate({ from: Route.fullPath });

  const { data: projectWithOrg } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
      projectSlug: params.projectSlug,
    }),
  );

  const { data: sandboxProviders } = useSuspenseQuery(
    trpc.project.getAvailableSandboxProviders.queryOptions(),
  );

  const { data: machines } = useSuspenseQuery(
    trpc.machine.list.queryOptions({
      projectSlug: params.projectSlug,
      includeArchived: false,
    }),
  );

  const enabledSandboxProviders = sandboxProviders.providers.filter(
    (provider) => !provider.disabledReason,
  );

  const hasRunningMachines = machines.some((m) => m.state === "active" || m.state === "starting");

  const project = projectWithOrg;
  const [name, setName] = useState(project.name);
  const [sandboxProvider, setSandboxProvider] = useState<ProjectSandboxProvider>(
    project.sandboxProvider as ProjectSandboxProvider,
  );

  const updateProject = useMutation({
    mutationFn: async (input: { name?: string; sandboxProvider?: ProjectSandboxProvider }) => {
      return trpcClient.project.update.mutate({
        projectSlug: params.projectSlug,
        ...input,
      });
    },
    onSuccess: () => {
      toast.success("Project updated");
    },
    onError: (error) => {
      toast.error("Failed to update project: " + error.message);
    },
  });

  const deleteProject = useMutation({
    mutationFn: async () => {
      return trpcClient.project.delete.mutate({
        projectSlug: params.projectSlug,
      });
    },
    onSuccess: () => {
      toast.success("Project deleted");
      navigate({
        to: "/orgs/$organizationSlug",
        params: { organizationSlug: projectWithOrg.organization.slug },
      });
    },
    onError: (error) => {
      toast.error("Failed to delete project: " + error.message);
    },
  });

  const hasNameChange = name.trim() && name !== project.name;
  const hasProviderChange = sandboxProvider !== project.sandboxProvider;
  const hasChanges = hasNameChange || hasProviderChange;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!hasChanges) return;

    updateProject.mutate({
      ...(hasNameChange ? { name: name.trim() } : {}),
      ...(hasProviderChange ? { sandboxProvider } : {}),
    });
  };

  const handleDelete = () => {
    if (deleteProject.isPending) {
      return;
    }
    const confirmed = window.confirm("Delete this project? This cannot be undone.");
    if (confirmed) {
      deleteProject.mutate();
    }
  };

  const canChangeProvider = enabledSandboxProviders.length >= 2 && !hasRunningMachines;

  return (
    <div className="p-4 space-y-8">
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="project-name">Name</FieldLabel>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={updateProject.isPending}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-slug">Slug</FieldLabel>
              <Input id="project-slug" value={project.slug} disabled />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-sandbox-provider">Sandbox provider</FieldLabel>
              {canChangeProvider ? (
                <Select
                  value={sandboxProvider}
                  onValueChange={(value) => setSandboxProvider(value as ProjectSandboxProvider)}
                  disabled={updateProject.isPending}
                >
                  <SelectTrigger id="project-sandbox-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledSandboxProviders.map((provider) => (
                      <SelectItem key={provider.type} value={provider.type}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <>
                  <Input
                    id="project-sandbox-provider"
                    value={SANDBOX_PROVIDER_LABELS[sandboxProvider] ?? sandboxProvider}
                    disabled
                  />
                  {hasRunningMachines && enabledSandboxProviders.length >= 2 && (
                    <p className="text-xs text-muted-foreground">
                      Archive all machines to change the sandbox provider.
                    </p>
                  )}
                </>
              )}
            </Field>
          </FieldSet>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!hasChanges || updateProject.isPending}>
              {updateProject.isPending ? "Saving..." : "Save"}
            </Button>
          </Field>
        </FieldGroup>
      </form>

      <div className="space-y-3">
        <div className="text-sm font-medium">Delete project</div>
        <Button variant="destructive" onClick={handleDelete} disabled={deleteProject.isPending}>
          {deleteProject.isPending ? "Deleting..." : "Delete project"}
        </Button>
      </div>
    </div>
  );
}
