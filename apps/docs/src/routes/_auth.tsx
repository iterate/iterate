import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createIterateClient } from "iterate/app";
import { usePosthogIdentity } from "@iterate-com/ui/components/posthog";
const iterate = createIterateClient();
export const Route = createFileRoute("/_auth")({
  ssr: false,
  // back to the page the browser addressed, its base path included
  beforeLoad: ({ context, location }) =>
    iterate.authenticate(`${context.basePath}${location.href}`),
  component: Identified,
});

function Identified() {
  usePosthogIdentity(Route.useRouteContext().info.principal);
  return <Outlet />;
}
