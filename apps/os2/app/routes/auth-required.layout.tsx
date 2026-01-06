import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout")({
  beforeLoad: async ({ context }) => {
    const user = await context.trpcClient.user.me.query();
    if (!user) {
      throw redirect({ to: "/login" });
    }
    return { user };
  },
  component: AuthLayout,
});

function AuthLayout() {
  return <Outlet />;
}
