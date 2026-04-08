import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { errorOccurredPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/error-occurred")({
  component: ErrorOccurredPageRoute,
});

function ErrorOccurredPageRoute() {
  return <EventTypePageView page={errorOccurredPage} />;
}
