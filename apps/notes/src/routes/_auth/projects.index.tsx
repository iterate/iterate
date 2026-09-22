// /projects opens the first project available to this session.
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DefaultPendingComponent } from "@iterate-com/ui/components/route-defaults";

export const Route = createFileRoute("/_auth/projects/")({
  loader: async ({ context }) => (await context.api.projects.list())[0] || null,
  component: ProjectsIndex,
});

function ProjectsIndex() {
  const first = Route.useLoaderData();
  // Navigate after this client-only route has mounted. Redirecting from beforeLoad during
  // initial hydration can leave TanStack's destination match in an error state without an error.
  if (first)
    return (
      <>
        <Navigate to="/projects/$slug" params={{ slug: first.slug }} replace />
        <DefaultPendingComponent />
      </>
    );
  return (
    <main className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
      No projects yet — create one in the dash.
    </main>
  );
}
