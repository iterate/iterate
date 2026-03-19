import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/jonasland/$projectSlug/deployments")({
  component: Outlet,
});
