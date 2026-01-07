import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { sessionQueryOptions } from "../lib/session-query.ts";

export const Route = createFileRoute("/_auth-required.layout")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions());

    if (!session?.user) {
      throw redirect({ to: "/login" });
    }

    return { session };
  },
  component: AuthRequiredLayout,
});

function AuthRequiredLayout() {
  return <Outlet />;
}
