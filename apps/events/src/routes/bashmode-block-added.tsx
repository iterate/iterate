import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { bashmodeBlockAddedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/bashmode-block-added")({
  component: BashmodeBlockAddedPage,
});

function BashmodeBlockAddedPage() {
  return <EventTypePageView page={bashmodeBlockAddedPage} />;
}
