import { createFileRoute } from "@tanstack/react-router";
import { proxyPosthogRequest } from "@iterate-com/shared/posthog";

export const Route = createFileRoute("/posthog-proxy/$")({
  server: {
    handlers: {
      ANY: async ({ request }) =>
        proxyPosthogRequest({
          request,
          proxyPrefix: "/posthog-proxy",
        }),
    },
  },
});
