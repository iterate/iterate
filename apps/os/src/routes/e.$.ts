import { createFileRoute } from "@tanstack/react-router";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";

export const Route = createFileRoute("/e/$")({
  server: {
    handlers: {
      ANY: ({ request }) => proxyPosthogRequest({ request, proxyPrefix: "/e" }),
    },
  },
});
