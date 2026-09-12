import { createFileRoute, Outlet } from "@tanstack/react-router";
import { iterate } from "./-client.ts";
import { ItxProvider } from "./-itx.tsx";

export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
  component: AuthLayout,
});

// Client-only (ssr: false): beforeLoad has already suspended until the itx WebSocket is up, so the
// resolved session is handed to the whole subtree through the provider — `useItx()` everywhere below.
function AuthLayout() {
  return (
    <ItxProvider app={Route.useRouteContext()}>
      <Outlet />
    </ItxProvider>
  );
}
