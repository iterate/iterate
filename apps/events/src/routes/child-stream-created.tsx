import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { childStreamCreatedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/child-stream-created")({
  component: ChildStreamCreatedPage,
});

function ChildStreamCreatedPage() {
  return <EventTypePageView page={childStreamCreatedPage} />;
}
