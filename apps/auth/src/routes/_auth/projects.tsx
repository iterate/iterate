import { useState, type ChangeEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@iterate-com/ui/components/card";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { Separator } from "@iterate-com/ui/components/separator";
import { Label } from "@iterate-com/ui/components/label";
import { toast } from "sonner";
import { orpcClient } from "../../utils/query.tsx";

export const Route = createFileRoute("/_auth/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const navigate = Route.useNavigate();
  const [organizationName, setOrganizationName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [selectedOrganizationSlug, setSelectedOrganizationSlug] = useState("");

  const projectInventoryQuery = useQuery({
    queryKey: ["project-inventory"],
    queryFn: async () => {
      const organizations = await orpcClient.user.myOrganizations();

      return Promise.all(
        organizations.map(async (organization) => ({
          organization,
          projects: await orpcClient.project.list({ organizationSlug: organization.slug }),
        })),
      );
    },
  });

  const createOrganizationMutation = useMutation({
    mutationFn: (name: string) => orpcClient.organization.create({ name }),
    onSuccess: async (organization) => {
      toast.success("Organization created");
      setOrganizationName("");
      setSelectedOrganizationSlug(organization.slug);
      await projectInventoryQuery.refetch();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const createProjectMutation = useMutation({
    mutationFn: (input: { organizationSlug: string; name: string }) =>
      orpcClient.project.create(input),
    onSuccess: async () => {
      toast.success("Project created");
      setProjectName("");
      await projectInventoryQuery.refetch();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const organizations = projectInventoryQuery.data ?? [];
  const effectiveOrganizationSlug =
    selectedOrganizationSlug || organizations[0]?.organization.slug || "";

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Projects</CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="flex gap-2">
            <Button variant="outline" onClick={() => navigate({ to: "/" })}>
              Back to account
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create organization</CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="organization-name">Organization name</Label>
              <Input
                id="organization-name"
                data-testid="organization-name-input"
                value={organizationName}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setOrganizationName(event.target.value)
                }
                placeholder="MCP Test Org"
              />
            </div>
            <Button
              className="w-full"
              disabled={
                createOrganizationMutation.isPending || organizationName.trim().length === 0
              }
              onClick={() => createOrganizationMutation.mutate(organizationName.trim())}
            >
              {createOrganizationMutation.isPending ? "Creating..." : "Create organization"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create project</CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-organization">Organization</Label>
              <NativeSelect
                id="project-organization"
                data-testid="project-organization-select"
                className="w-full"
                value={effectiveOrganizationSlug}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  setSelectedOrganizationSlug(event.target.value)
                }
                disabled={organizations.length === 0 || createProjectMutation.isPending}
              >
                {organizations.length === 0 ? (
                  <NativeSelectOption value="">Create an organization first</NativeSelectOption>
                ) : (
                  organizations.map(({ organization }) => (
                    <NativeSelectOption key={organization.id} value={organization.slug}>
                      {organization.name}
                    </NativeSelectOption>
                  ))
                )}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                data-testid="project-name-input"
                value={projectName}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setProjectName(event.target.value)
                }
                placeholder="MCP Alpha"
              />
            </div>
            <Button
              className="w-full"
              disabled={
                createProjectMutation.isPending ||
                projectName.trim().length === 0 ||
                effectiveOrganizationSlug.length === 0
              }
              onClick={() =>
                createProjectMutation.mutate({
                  organizationSlug: effectiveOrganizationSlug,
                  name: projectName.trim(),
                })
              }
            >
              {createProjectMutation.isPending ? "Creating..." : "Create project"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Current projects</CardTitle>
          </CardHeader>
          <Separator />
          <CardContent>
            {projectInventoryQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : projectInventoryQuery.isError ? (
              <p className="text-sm text-destructive">{projectInventoryQuery.error.message}</p>
            ) : organizations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No organizations or projects yet. Create one above to start testing.
              </p>
            ) : (
              <div className="space-y-3">
                {organizations.map(({ organization, projects }) => (
                  <div key={organization.id} className="space-y-2 rounded-lg border bg-card p-4">
                    <div>
                      <p className="text-sm font-medium">{organization.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {organization.slug} · {organization.role}
                      </p>
                    </div>
                    {projects.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No projects in this organization.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {projects.map((project) => (
                          <div
                            key={project.id}
                            className="flex items-start justify-between gap-4 rounded-lg border bg-background p-3"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{project.name}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {project.slug}
                              </p>
                              <p className="truncate font-mono text-xs text-muted-foreground">
                                {project.id}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
