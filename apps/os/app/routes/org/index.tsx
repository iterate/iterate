import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Box, Plus } from "lucide-react";
import { trpc } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { EmptyState } from "../../components/empty-state.tsx";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "../../components/ui/item.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/")({
  component: OrgHomePage,
});

function OrgHomePage() {
  const params = useParams({ from: "/_auth/orgs/$organizationSlug/" });

  const { data: org } = useSuspenseQuery(
    trpc.organization.withProjects.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const projects = org?.projects ?? [];

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Button asChild>
          <Link
            to="/orgs/$organizationSlug/new-project"
            params={{ organizationSlug: params.organizationSlug }}
          >
            <Plus className="h-4 w-4" />
            New project
          </Link>
        </Button>
      </div>

      {projects.length === 0 ? (
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
                <Plus className="h-4 w-4" />
                Create project
              </Link>
            </Button>
          }
        />
      ) : (
        <ItemGroup className="rounded-lg border">
          {projects.map((project, index) => (
            <div key={project.id}>
              {index > 0 && <ItemSeparator />}
              <Item asChild variant="default" className="hover:bg-accent/50 cursor-pointer">
                <Link
                  to="/orgs/$organizationSlug/projects/$projectSlug"
                  params={{
                    organizationSlug: params.organizationSlug,
                    projectSlug: project.slug,
                  }}
                >
                  <ItemMedia variant="icon">
                    <Box className="h-4 w-4" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{project.name}</ItemTitle>
                  </ItemContent>
                </Link>
              </Item>
            </div>
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
