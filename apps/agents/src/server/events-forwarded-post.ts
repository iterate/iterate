import { Event } from "@iterate-com/events-contract";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import type { AppContext } from "~/context.ts";

/**
 * POST /api/events-forwarded — must run from the `/api/$` catch-all before oRPC,
 * otherwise this path is handled by {@link orpcOpenApiHandler} and returns 404.
 */
export async function handleEventsForwardedPost(args: {
  context: AppContext;
  request: Request;
}): Promise<Response> {
  const event = Event.parse(await args.request.json());

  if (!JSON.stringify(event.payload ?? event).includes("ping")) {
    return Response.json({ appended: false, ok: true });
  }

  const eventsClient = createEventsOrpcClient({
    baseUrl: args.context.config.eventsBaseUrl,
    projectSlug: args.context.config.eventsProjectSlug,
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
}
