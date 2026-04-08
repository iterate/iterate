import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamSubscriptionConfiguredPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-subscription-configured")({
  component: StreamSubscriptionConfiguredPageRoute,
});

function StreamSubscriptionConfiguredPageRoute() {
  return <EventTypePageView page={streamSubscriptionConfiguredPage} />;
}
