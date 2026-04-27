import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/projects")({
  staticData: {
    breadcrumb: "Projects",
  },
  component: ProjectsLayout,
});

function ProjectsLayout() {
  return <Outlet />;
}
