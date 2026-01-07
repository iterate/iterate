import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Box, Plus } from "lucide-react";
import { trpc } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.tsx";
import { EmptyState } from "../../components/empty-state.tsx";

export const Route = createFileRoute("/_auth.layout/orgs/$organizationSlug/")({
  component: OrgDashboardPage,
});

function OrgDashboardPage() {
  const params = useParams({
    from: "/_auth.layout/orgs/$organizationSlug/",
  });

  const { data: org } = useSuspenseQuery(
    trpc.organization.withProjects.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const projects = org?.projects || [];

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{org?.name}</h1>
        <Button asChild>
          <Link
            to="/orgs/$organizationSlug/new-project"
            params={{ organizationSlug: params.organizationSlug }}
          >
            <Plus className="mr-2 h-4 w-4" />
            New project
          </Link>
        </Button>
      </div>

      {projects.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((project) => (
            <Link
              key={project.id}
              to="/orgs/$organizationSlug/projects/$projectSlug"
              params={{
                organizationSlug: params.organizationSlug,
                projectSlug: project.slug,
              }}
              className="block"
            >
              <Card className="transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Box className="h-5 w-5" />
                    {project.name}
                  </CardTitle>
                  <CardDescription>{project.slug}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Box className="h-12 w-12" />}
          title="No projects yet"
          description="Create your first project to get started."
          action={
            <Button asChild>
              <Link
                to="/orgs/$organizationSlug/new-project"
                params={{ organizationSlug: params.organizationSlug }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create project
              </Link>
            </Button>
          }
        />
      )}
    </div>
  );
}
