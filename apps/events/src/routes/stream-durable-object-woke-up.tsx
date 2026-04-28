import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { streamDurableObjectWokeUpPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/stream-durable-object-woke-up")({
  component: StreamDurableObjectWokeUpPage,
});

function StreamDurableObjectWokeUpPage() {
  return <EventTypePageView page={streamDurableObjectWokeUpPage} />;
}
