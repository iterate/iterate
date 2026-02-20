import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "../../components/ui/field.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";

type ProjectSandboxProvider = "daytona" | "docker" | "fly";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/new-project")({
  component: NewProjectPage,
  loader: ({ context, params }) => {
    // Non-blocking prefetch - component will suspend if data not ready
    context.queryClient.prefetchQuery(
      trpc.organization.withProjects.queryOptions({ organizationSlug: params.organizationSlug }),
    );
    context.queryClient.prefetchQuery(trpc.project.getAvailableSandboxProviders.queryOptions());
  },
});

function NewProjectPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/new-project",
  });
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();

  // Suspends if data not ready → shows ContentSpinner from parent layout
  const { data: org } = useSuspenseQuery(
    trpc.organization.withProjects.queryOptions({ organizationSlug: params.organizationSlug }),
  );
  const { data: sandboxProviders } = useSuspenseQuery(
    trpc.project.getAvailableSandboxProviders.queryOptions(),
  );
  const enabledSandboxProviders = sandboxProviders.providers.filter(
    (provider) => !provider.disabledReason,
  );
  const hasEnabledSandboxProvider = enabledSandboxProviders.length > 0;

  // Default name for first project is org name (slug will match org slug)
  const isFirstProject = !org?.projects?.length;
  const defaultName = isFirstProject ? (org?.name ?? "") : "";
  const [name, setName] = useState(defaultName);
  const [sandboxProvider, setSandboxProvider] = useState<ProjectSandboxProvider>(
    sandboxProviders.defaultProvider,
  );

  const createProject = useMutation({
    mutationFn: async (input: { projectName: string; sandboxProvider: ProjectSandboxProvider }) => {
      return trpcClient.project.create.mutate({
        organizationSlug: params.organizationSlug,
        name: input.projectName,
        sandboxProvider: input.sandboxProvider,
      });
    },
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({
        queryKey: trpc.organization.withProjects.queryKey({
          organizationSlug: params.organizationSlug,
        }),
      });
      toast.success("Project created");
      navigate({
        to: "/proj/$projectSlug",
        params: { projectSlug: project.slug },
      });
    },
    onError: (error) => {
      toast.error("Failed to create project: " + error.message);
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && hasEnabledSandboxProvider) {
      createProject.mutate({
        projectName: name.trim(),
        sandboxProvider,
      });
    }
  };

  return (
    <div className="p-8 max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">New project</h1>
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="project-name">Project name</FieldLabel>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={createProject.isPending}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel>Sandbox provider</FieldLabel>
              <Select
                value={sandboxProvider}
                onValueChange={(value) => setSandboxProvider(value as ProjectSandboxProvider)}
                disabled={createProject.isPending}
              >
                <SelectTrigger>
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
            </Field>
          </FieldSet>
          <Field orientation="horizontal">
            <Button
              type="submit"
              disabled={!name.trim() || !hasEnabledSandboxProvider || createProject.isPending}
            >
              {createProject.isPending ? "Creating..." : "Create project"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
}
