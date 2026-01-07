import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "../../lib/trpc.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/")({
  component: OrganizationIndexPage,
});

function OrganizationIndexPage() {
  const { organizationSlug } = Route.useParams();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: projects } = useSuspenseQuery(trpc.project.list.queryOptions({ organizationSlug }));

  const [newProjectName, setNewProjectName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const createProject = useMutation(
    trpc.project.create.mutationOptions({
      onSuccess: (project) => {
        queryClient.invalidateQueries({
          queryKey: trpc.project.list.queryKey({ organizationSlug }),
        });
        navigate({
          to: "/$organizationSlug/$projectSlug",
          params: { organizationSlug, projectSlug: project.slug },
        });
      },
    }),
  );

  const handleCreateProject = () => {
    if (!newProjectName.trim()) return;
    createProject.mutate({ organizationSlug, name: newProjectName });
  };

  if (projects.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle>No Projects</CardTitle>
            <CardDescription>Create your first project to get started.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isCreating ? (
              <div className="space-y-2">
                <Input
                  placeholder="Project name"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button
                    onClick={handleCreateProject}
                    disabled={!newProjectName.trim() || createProject.isPending}
                  >
                    {createProject.isPending ? "Creating..." : "Create"}
                  </Button>
                  <Button variant="outline" onClick={() => setIsCreating(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button onClick={() => setIsCreating(true)} className="w-full">
                Create Project
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        {isCreating ? (
          <div className="flex gap-2">
            <Input
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
              autoFocus
            />
            <Button
              onClick={handleCreateProject}
              disabled={!newProjectName.trim() || createProject.isPending}
            >
              {createProject.isPending ? "Creating..." : "Create"}
            </Button>
            <Button variant="outline" onClick={() => setIsCreating(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button onClick={() => setIsCreating(true)}>New Project</Button>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <Card
            key={project.id}
            className="cursor-pointer hover:bg-accent/50"
            onClick={() =>
              navigate({
                to: "/$organizationSlug/$projectSlug",
                params: { organizationSlug, projectSlug: project.slug },
              })
            }
          >
            <CardHeader>
              <CardTitle>{project.name}</CardTitle>
              <CardDescription>{project.slug}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
