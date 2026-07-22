import { Outlet, createFileRoute } from "@tanstack/react-router";

// No breadcrumb here: the projects LIST labels itself, and the project home
// (the new-agent dashboard) deliberately shows no label — a breadcrumb on
// this layout route would leak "Projects" onto every child without one.
export const Route = createFileRoute("/_app/projects")({
  component: () => <Outlet />,
});
