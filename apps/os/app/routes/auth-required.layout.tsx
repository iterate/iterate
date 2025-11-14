import { createFileRoute } from "@tanstack/react-router";
import { Outlet } from "@tanstack/react-router";
import { authenticatedServerFn } from "../lib/auth-middleware.ts";

const assertAuthenticated = authenticatedServerFn.handler(() => {});

export const Route = createFileRoute("/_auth.layout")({
  beforeLoad: () => assertAuthenticated(),
  component: Outlet,
});
