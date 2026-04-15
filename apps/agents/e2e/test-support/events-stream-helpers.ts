import type { ContractRouterClient } from "@orpc/contract";
import {
  Event,
  type Event as EventsEvent,
  eventsContract,
  type StreamPath,
} from "@iterate-com/events-contract";

/**
 * Finite snapshot of all events currently on the stream (same semantics as
 * `GET /streams/{path}?afterOffset=start&beforeOffset=end`).
 */
async function readFiniteStreamHistory(
  client: ContractRouterClient<typeof eventsContract>,
  path: StreamPath,
): Promise<EventsEvent[]> {
  const stream = await client.stream({
    path,
    afterOffset: "start",
    beforeOffset: "end",
  });
  const events: EventsEvent[] = [];
  for await (const value of stream) {
    events.push(Event.parse(value));
  }
  return events;
}

export async function waitForStreamEvent(args: {
  client: ContractRouterClient<typeof eventsContract>;
  path: StreamPath;
  predicate: (event: EventsEvent) => boolean;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<EventsEvent> {
  const deadline = Date.now() + (args.timeoutMs ?? 120_000);
  const pollMs = args.pollMs ?? 500;
  let lastTypes: string[] = [];

  while (Date.now() < deadline) {
    const snapshot = await readFiniteStreamHistory(args.client, args.path);
    lastTypes = snapshot.map((event) => event.type);
    const matched = snapshot.find(args.predicate);
    if (matched) {
      return matched;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out waiting for matching event on ${args.path}; last types: ${lastTypes.join(", ") || "(empty)"}`,
  );
}

/**
 * Human-readable Events UI link (`projectSlug` selects the project in the sidebar).
 */
export function eventsIterateStreamViewerUrl(args: {
  eventsOrigin: string;
  projectSlug: string;
  streamPath: StreamPath;
}): string {
  const origin = args.eventsOrigin.replace(/\/+$/, "");
  const splat =
    args.streamPath === "/"
      ? ""
      : args.streamPath.startsWith("/")
        ? args.streamPath.slice(1)
        : args.streamPath;
  const pathSegments =
    splat.length === 0 ? [] : splat.split("/").map((segment) => encodeURIComponent(segment));
  const pathname = pathSegments.length === 0 ? "/streams/" : `/streams/${pathSegments.join("/")}`;
  const url = new URL(pathname, `${origin}/`);
  url.searchParams.set("projectSlug", args.projectSlug);
  return url.toString();
}
