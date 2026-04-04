import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamDurableObjectConstructedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-durable-object-constructed")({
  component: RouteComponent,
});

function RouteComponent() {
  return <EventTypePageView page={streamDurableObjectConstructedPage} />;
}
