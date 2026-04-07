import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { scheduleExecutionStartedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/schedule-execution-started")({
  component: ScheduleExecutionStartedPageRoute,
});

function ScheduleExecutionStartedPageRoute() {
  return <EventTypePageView page={scheduleExecutionStartedPage} />;
}
