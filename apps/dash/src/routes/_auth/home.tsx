// Where a signed-in browser lands (the worker sends `/` here, the login door's `next` too), the way
// apps/os's root decides: exactly one project → that project; otherwise the projects list. The list
// itself never redirects — the switcher's "All projects" must not hijack a single-project person back.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/home")({
  beforeLoad: async ({ context }) => {
    const projects = await context.api.projects.list();
    throw redirect(
      projects.length === 1
        ? { to: "/projects/$slug", params: { slug: projects[0]!.slug } }
        : { to: "/projects" },
    );
  },
});
