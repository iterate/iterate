import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { PostHogProvider as _PostHogProvider } from "posthog-js/react";
import { RootComponent } from "../root-component.tsx";
import type { TanstackRouterContext } from "../router.tsx";

export const Route = createRootRouteWithContext<TanstackRouterContext>()({
  component: RootLayout,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(context.trpc.user.me.queryOptions());
    await context.queryClient.ensureQueryData(context.trpc.admin.impersonationInfo.queryOptions());
  },
  wrapInSuspense: true,
});

function RootLayout() {
  return (
    <RootComponent>
      <Outlet />
    </RootComponent>
  );
}
