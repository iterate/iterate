import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { scheduleConfiguredPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/schedule-configured")({
  component: ScheduleConfiguredPageRoute,
});

function ScheduleConfiguredPageRoute() {
  return <EventTypePageView page={scheduleConfiguredPage} />;
}
