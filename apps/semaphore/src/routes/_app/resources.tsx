import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/resources")({
  component: Outlet,
  staticData: {
    breadcrumb: "Resources",
  },
});
