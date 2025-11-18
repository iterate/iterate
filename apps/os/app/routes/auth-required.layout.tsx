import { createFileRoute } from "@tanstack/react-router";
import { Outlet } from "@tanstack/react-router";
import { authenticatedServerFn } from "../lib/auth-middleware.ts";

const assertAuthenticated = authenticatedServerFn.handler(() => {});

export const Route = createFileRoute("/_auth.layout")({
  beforeLoad: () => assertAuthenticated(),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(context.trpc.user.me.queryOptions());
    await context.queryClient.ensureQueryData(context.trpc.admin.impersonationInfo.queryOptions());
  },
  component: Outlet,
});
