import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamDurableObjectConstructedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-durable-object-constructed")({
  component: StreamDurableObjectConstructedPage,
});

function StreamDurableObjectConstructedPage() {
  return <EventTypePageView page={streamDurableObjectConstructedPage} />;
}
