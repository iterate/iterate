import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/new-project")({
  component: NewProjectPage,
  loader: async ({ context, params }) => {
    const org = await context.queryClient.ensureQueryData(
      trpc.organization.withProjects.queryOptions({ organizationSlug: params.organizationSlug }),
    );
    return { defaultName: org?.projects?.length ? "" : "main" };
  },
});

function NewProjectPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/new-project",
  });
  const { defaultName } = Route.useLoaderData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState(defaultName);

  const createProject = useMutation({
    mutationFn: async (projectName: string) => {
      return trpcClient.project.create.mutate({
        organizationSlug: params.organizationSlug,
        name: projectName,
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
        to: "/orgs/$organizationSlug/projects/$projectSlug",
        params: { organizationSlug: params.organizationSlug, projectSlug: project.slug },
      });
    },
    onError: (error) => {
      toast.error("Failed to create project: " + error.message);
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) {
      createProject.mutate(name.trim());
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
          </FieldSet>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!name.trim() || createProject.isPending}>
              {createProject.isPending ? "Creating..." : "Create project"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
}
