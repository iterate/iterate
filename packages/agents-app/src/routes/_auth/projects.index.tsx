import { createFileRoute } from "@tanstack/react-router";
import { FirstProjectRedirect } from "@iterate-com/ui/components/first-project-redirect";

export const Route = createFileRoute("/_auth/projects/")({
  loader: async ({ context }) => (await context.api.projects.list())[0] || null,
  component: ProjectsIndex,
});

function ProjectsIndex() {
  const first = Route.useLoaderData();
  return <FirstProjectRedirect project={first} />;
}
