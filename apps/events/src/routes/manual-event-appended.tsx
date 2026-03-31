import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { manualEventAppendedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/manual-event-appended")({
  component: ManualEventAppendedPage,
});

function ManualEventAppendedPage() {
  return <EventTypePageView page={manualEventAppendedPage} />;
}
