import { Outlet, createFileRoute } from "@tanstack/react-router";
import { breadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";

export const Route = createFileRoute("/_app/projects")({
  staticData: breadcrumbStaticData("Projects"),
  component: () => <Outlet />,
});
