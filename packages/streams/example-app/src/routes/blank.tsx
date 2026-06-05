import { createFileRoute } from "@tanstack/react-router";

// Minimal neutral page. Playwright uses it as a same-origin tab that holds a
// stream writer Web Lock without itself subscribing to any stream.
export const Route = createFileRoute("/blank")({
  component: () => null,
});
