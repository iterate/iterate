import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { agentInputAddedPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/agent-input-added")({
  component: AgentInputAddedPage,
});

function AgentInputAddedPage() {
  return <EventTypePageView page={agentInputAddedPage} />;
}
