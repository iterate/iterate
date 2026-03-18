import { createFileRoute } from "@tanstack/react-router";
import { StreamInspector } from "@/components/stream-inspector.tsx";

export const Route = createFileRoute("/_app/streams")({
  ssr: false,
  component: StreamsPage,
});

function StreamsPage() {
  return <StreamInspector />;
}
