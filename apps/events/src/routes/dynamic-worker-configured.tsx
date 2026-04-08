import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { dynamicWorkerConfiguredPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/dynamic-worker-configured")({
  component: DynamicWorkerConfiguredPageRoute,
});

function DynamicWorkerConfiguredPageRoute() {
  return <EventTypePageView page={dynamicWorkerConfiguredPage} />;
}
