import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { scheduleExecutionFinishedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/schedule-execution-finished")({
  component: ScheduleExecutionFinishedPageRoute,
});

function ScheduleExecutionFinishedPageRoute() {
  return <EventTypePageView page={scheduleExecutionFinishedPage} />;
}
