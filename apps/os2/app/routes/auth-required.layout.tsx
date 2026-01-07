import { createFileRoute, Outlet } from "@tanstack/react-router";
import { authMiddleware } from "../lib/auth-middleware.ts";

export const Route = createFileRoute("/_auth-required")({
  component: AuthRequiredLayout,
  server: {
    middleware: [authMiddleware],
  },
});

function AuthRequiredLayout() {
  return <Outlet />;
}
