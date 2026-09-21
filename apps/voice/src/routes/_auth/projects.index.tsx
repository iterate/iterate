// /projects — where a sign-in lands: the first project the session lists, at its slug
// (`/projects/<slug>` is the shape of a project URL in every app); none → a line.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/projects/")({
  beforeLoad: async ({ context }) => {
    const [first] = await context.api.projects.list();
    if (first) throw redirect({ to: "/projects/$slug", params: { slug: first.slug } });
  },
  component: () => (
    <main className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
      No projects yet — create one in the dash.
    </main>
  ),
});
