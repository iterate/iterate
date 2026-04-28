import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { htmlRendererConfiguredPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/html-renderer-configured")({
  component: HtmlRendererConfiguredPageRoute,
});

function HtmlRendererConfiguredPageRoute() {
  return <EventTypePageView page={htmlRendererConfiguredPage} />;
}
