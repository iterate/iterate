import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { scheduleCancelledPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/schedule-cancelled")({
  component: ScheduleCancelledPageRoute,
});

function ScheduleCancelledPageRoute() {
  return <EventTypePageView page={scheduleCancelledPage} />;
}
