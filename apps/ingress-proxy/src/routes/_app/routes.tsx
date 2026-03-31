import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/routes")({
  component: Outlet,
  staticData: {
    breadcrumb: "Routes",
  },
});
