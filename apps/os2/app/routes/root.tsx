import { createRootRoute, Outlet } from "@tanstack/react-router";
import { RootComponent } from "../root-component.tsx";

export const Route = createRootRoute({
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
