import { createFileRoute, Outlet } from "@tanstack/react-router";
import { authenticatedServerFn } from "../lib/auth-middleware.ts";
import { trpc } from "../lib/trpc.tsx";

const assertAuthenticated = authenticatedServerFn.handler(() => {});

export const Route = createFileRoute("/_auth.layout")({
  beforeLoad: () => assertAuthenticated(),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(trpc.user.me.queryOptions());
    await context.queryClient.ensureQueryData(trpc.admin.impersonationInfo.queryOptions());
  },
  component: AuthRequiredLayout,
});

function AuthRequiredLayout() {
  return <Outlet />;
}
