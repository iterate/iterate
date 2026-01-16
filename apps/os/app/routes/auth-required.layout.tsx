import { createFileRoute, Outlet } from "@tanstack/react-router";
import { authenticatedServerFn } from "../lib/auth-middleware.ts";
import { trpc } from "../lib/trpc.tsx";
import { useSessionUser } from "../hooks/use-session-user.ts";
import { usePostHogIdentity } from "../hooks/use-posthog-identity.tsx";

const assertAuthenticated = authenticatedServerFn.handler(() => {});

export const Route = createFileRoute("/_auth")({
  beforeLoad: () => assertAuthenticated(),
  loader: async ({ context }) => {
    // Blocking: must have user data before rendering any auth-required content
    await context.queryClient.ensureQueryData(trpc.user.me.queryOptions());
    await context.queryClient.ensureQueryData(trpc.admin.impersonationInfo.queryOptions());

    // Non-blocking: prefetch org list for sidebar switcher (available earlier)
    context.queryClient.prefetchQuery(trpc.user.myOrganizations.queryOptions());
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
