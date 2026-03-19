import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { orpc, orpcClient } from "@/lib/orpc.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/new-project")({
  component: NewProjectPage,
  loader: ({ context, params }) => {
    // Non-blocking prefetch - component will suspend if data not ready
    context.queryClient.prefetchQuery(
      orpc.organization.withProjects.queryOptions({
        input: { organizationSlug: params.organizationSlug },
      }),
    );
    context.queryClient.prefetchQuery(orpc.project.getAvailableSandboxProviders.queryOptions());
  },
});

function NewProjectPage() {
  const params = Route.useParams();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  // Suspends if data not ready → shows ContentSpinner from parent layout
  const { data: org } = useSuspenseQuery(
    orpc.organization.withProjects.queryOptions({
      input: { organizationSlug: params.organizationSlug },
    }),
  );
  const { data: sandboxProviders } = useSuspenseQuery(
    orpc.project.getAvailableSandboxProviders.queryOptions(),
  );
  const enabledSandboxProviders = sandboxProviders.providers.filter(
    (provider) => !provider.disabledReason,
  );
  const hasEnabledSandboxProvider = enabledSandboxProviders.length > 0;

  // Default name for first project is org name (slug will match org slug)
  const isFirstProject = !org?.projects?.length;
  const defaultName = isFirstProject ? (org?.name ?? "") : "";
  const [name, setName] = useState(defaultName);
  const [jonasLand, setJonasLand] = useState(false);
  const [sandboxProvider, setSandboxProvider] = useState(sandboxProviders.defaultProvider);
  const selectedSandboxProvider = sandboxProviders.providers.find(
    (provider) => provider.type === sandboxProvider,
  );

  const createProject = useMutation({
    mutationFn: () =>
      orpcClient.project.create({
        organizationSlug: params.organizationSlug,
        name: name.trim(),
        sandboxProvider,
        jonasLand,
      }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({
        queryKey: orpc.organization.withProjects.key({
          input: { organizationSlug: params.organizationSlug },
        }),
      });
      toast.success("Project created");
      navigate({
        to: project.jonasLand ? "/jonasland/$projectSlug" : "/proj/$projectSlug",
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
      createProject.mutate();
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
            <Field orientation="horizontal">
              <Checkbox
                id="jonas-land"
                checked={jonasLand}
                onCheckedChange={(checked) => setJonasLand(checked === true)}
                disabled={createProject.isPending}
              />
              <div data-slot="field-content" className="space-y-1">
                <FieldLabel htmlFor="jonas-land">jonasland</FieldLabel>
                <p className="text-sm text-muted-foreground">
                  Open this project in the jonasland renderer.
                </p>
              </div>
            </Field>
            {sandboxProviders.showProviderSelector ? (
              <Field>
                <FieldLabel>Sandbox provider</FieldLabel>
                <Select
                  value={sandboxProvider}
                  onValueChange={(value) => setSandboxProvider(value as typeof sandboxProvider)}
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
            ) : (
              <Field>
                <FieldLabel>Sandbox provider</FieldLabel>
                <Input value={selectedSandboxProvider?.label ?? sandboxProvider} disabled />
              </Field>
            )}
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
