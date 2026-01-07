import { createFileRoute, Outlet } from "@tanstack/react-router";
import { authenticatedServerFn } from "../lib/auth-middleware.ts";

const assertAuthenticated = authenticatedServerFn.handler(() => {});

export const Route = createFileRoute("/_auth-required.layout")({
  beforeLoad: () => assertAuthenticated(),
  component: AuthRequiredLayout,
});

function AuthRequiredLayout() {
  return <Outlet />;
}
