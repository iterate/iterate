import { useState, type FormEvent } from "react";
import { createFileRoute, useParams, useNavigate } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute("/_auth/proj/$projectSlug/settings")({
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const params = useParams({
    from: "/_auth/proj/$projectSlug/settings",
  });
  const navigate = useNavigate({ from: Route.fullPath });

  // bySlug returns project with organization
  const { data: projectWithOrg } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
      projectSlug: params.projectSlug,
    }),
  );

  const project = projectWithOrg;
  const [name, setName] = useState(project.name);

  const updateProject = useMutation({
    mutationFn: async (nextName: string) => {
      return trpcClient.project.update.mutate({
        projectSlug: params.projectSlug,
        name: nextName,
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
      // Navigate to org page after deletion
      navigate({
        to: "/orgs/$organizationSlug",
        params: { organizationSlug: projectWithOrg.organization.slug },
      });
    },
    onError: (error) => {
      toast.error("Failed to delete project: " + error.message);
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && name !== project.name) {
      updateProject.mutate(name.trim());
    }
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
              <Input id="project-sandbox-provider" value={project.sandboxProvider} disabled />
            </Field>
          </FieldSet>
          <Field orientation="horizontal">
            <Button
              type="submit"
              disabled={!name.trim() || name === project.name || updateProject.isPending}
            >
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
