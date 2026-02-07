import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc.tsx";

export const Route = createFileRoute("/_auth/proj/$projectSlug/")({
  // Note: project.bySlug is already preloaded in the parent proj layout
  component: ProjectHomePage,
});

function ProjectHomePage() {
  const params = useParams({
    from: "/_auth/proj/$projectSlug/",
  });

  const { data: _project } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({
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
