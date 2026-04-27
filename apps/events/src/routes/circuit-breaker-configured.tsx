import { createFileRoute } from "@tanstack/react-router";
import { EventTypePageView } from "~/components/event-type-page.tsx";
import { circuitBreakerConfiguredPage } from "~/lib/event-type-pages.ts";

export const Route = createFileRoute("/circuit-breaker-configured")({
  component: CircuitBreakerConfiguredPageRoute,
});

function CircuitBreakerConfiguredPageRoute() {
  return <EventTypePageView page={circuitBreakerConfiguredPage} />;
}
