import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createIterateClient } from "iterate/next/app";
import { usePosthogIdentity } from "@iterate-com/ui/components/posthog";
const iterate = createIterateClient();
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
  component: Identified,
});

function Identified() {
  usePosthogIdentity(Route.useRouteContext().info.principal);
  return <Outlet />;
}
