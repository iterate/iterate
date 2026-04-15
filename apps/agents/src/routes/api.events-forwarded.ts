import { createFileRoute } from "@tanstack/react-router";
import { Event } from "@iterate-com/events-contract";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";

export const Route = createFileRoute("/api/events-forwarded")({
  server: {
    handlers: {
      POST: async ({ context, request }) => {
        const event = Event.parse(await request.json());

        if (!JSON.stringify(event.payload ?? event).includes("ping")) {
          return Response.json({ appended: false, ok: true });
        }

        const eventsClient = createEventsOrpcClient({
          baseUrl: context.config.eventsBaseUrl,
          projectSlug: context.config.eventsProjectSlug,
        });

        await eventsClient.append({
          path: event.streamPath,
          event: {
            type: "pong",
            payload: {
              ok: true,
            },
          },
        });

        return Response.json({ appended: true, ok: true });
      },
    },
  },
});
