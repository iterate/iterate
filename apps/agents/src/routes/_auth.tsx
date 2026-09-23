import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { createIterateClient } from "iterate/next/app";
import { syncPosthogContext } from "@iterate-com/ui/components/posthog";
const iterate = createIterateClient();
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
  component: Identified,
});

/** PostHog: the person is the platform user id — the same person in every app. */
function Identified() {
  const { principal } = Route.useRouteContext().info;
  useEffect(() => {
    syncPosthogContext({
      person: {
        distinctId: principal.actor,
        properties: principal.email ? { email: principal.email } : {},
      },
      groups: [],
    });
  }, [principal.actor, principal.email]);
  return <Outlet />;
}
