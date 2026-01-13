import { createFileRoute, Outlet } from "@tanstack/react-router";
import { authenticatedServerFn } from "../lib/auth-middleware.ts";
import { trpc } from "../lib/trpc.tsx";
import { useSessionUser } from "../hooks/use-session-user.ts";
import { usePostHogIdentity } from "../hooks/use-posthog-identity.tsx";

const assertAuthenticated = authenticatedServerFn.handler(() => {});

export const Route = createFileRoute("/_auth/layout")({
  beforeLoad: () => assertAuthenticated(),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(trpc.user.me.queryOptions());
    await context.queryClient.ensureQueryData(trpc.admin.impersonationInfo.queryOptions());
  },
  component: AuthRequiredLayout,
});

function AuthRequiredLayout() {
  const { user } = useSessionUser();

  // Identify user in PostHog for all authenticated routes
  // Org/project layouts will add group context
  usePostHogIdentity({ user: user ?? null });

  return <Outlet />;
}
