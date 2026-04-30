import { Outlet, createFileRoute } from "@tanstack/react-router";
import { requireActiveOrganizationForRoute } from "../lib/auth.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: () => requireActiveOrganizationForRoute(),
  component: AppLayout,
});

function AppLayout() {
  return <Outlet />;
}
