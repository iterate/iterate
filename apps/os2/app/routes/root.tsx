import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { RootComponent } from "../root-component.tsx";
import type { TanstackRouterContext } from "../router.tsx";

export const Route = createRootRouteWithContext<TanstackRouterContext>()({
  component: RootLayout,
  wrapInSuspense: true,
});

function RootLayout() {
  return (
    <RootComponent>
      <Outlet />
    </RootComponent>
  );
}
