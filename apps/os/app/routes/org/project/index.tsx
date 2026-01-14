import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { trpc } from "../../../lib/trpc.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/projects/$projectSlug/")({
  component: ProjectHomeRoute,
});

function ProjectHomeRoute() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <ProjectHomePage />
    </Suspense>
  );
}

function ProjectHomePage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/",
  });

  const { data: _project } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  return (
    <div className="p-4 space-y-6" data-component="ProjectHomePage">
      <p className="text-muted-foreground">
        Welcome to your project. Use the sidebar to navigate to different sections.
      </p>
    </div>
  );
}
