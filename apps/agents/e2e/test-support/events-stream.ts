import type { ContractRouterClient } from "@orpc/contract";
import {
  Event,
  ProjectSlug,
  type Event as EventsEvent,
  eventsContract,
  type StreamPath,
} from "@iterate-com/events-contract";
import { createEventsOrpcClient } from "../../src/lib/events-orpc-client.ts";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";

export type EventsClient = ContractRouterClient<typeof eventsContract>;

export interface EventsHelpers {
  append(path: StreamPath, event: { type: string; payload: object }): Promise<void>;
  waitForEvent(
    path: StreamPath,
    predicate: (event: EventsEvent) => boolean,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<EventsEvent>;
  client: EventsClient;
  streamViewerUrl(path: StreamPath): string;
}

export function createEventsHelpers(params: {
  baseUrl: string;
  projectSlug: string;
}): EventsHelpers {
  const client = createEventsOrpcClient({
    baseUrl: params.baseUrl,
    projectSlug: params.projectSlug,
  });

  return {
    async append(path, event) {
      await client.append({ path, event });
    },

    async waitForEvent(path, predicate, opts) {
      return await waitForStreamEvent({
        client,
        path,
        predicate,
        timeoutMs: opts?.timeoutMs,
        pollMs: opts?.pollMs,
      });
    },

    client,

    streamViewerUrl(path) {
      return eventsStreamViewerUrl({
        eventsOrigin: params.baseUrl,
        projectSlug: params.projectSlug,
        streamPath: path,
      });
    },
  };
}

/**
 * Finite snapshot of all events currently on the stream (same semantics as
 * `GET /streams/{path}?afterOffset=start&beforeOffset=end`).
 */
async function readFiniteStreamHistory(
  client: EventsClient,
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

async function waitForStreamEvent(args: {
  client: EventsClient;
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

function eventsStreamViewerUrl(args: {
  eventsOrigin: string;
  projectSlug: string;
  streamPath: StreamPath;
}): string {
  const projectBase = getProjectUrl({
    currentUrl: args.eventsOrigin,
    projectSlug: ProjectSlug.parse(args.projectSlug),
  })
    .toString()
    .replace(/\/+$/, "");
  const splat =
    args.streamPath === "/"
      ? ""
      : args.streamPath.startsWith("/")
        ? args.streamPath.slice(1)
        : args.streamPath;
  const pathSegments =
    splat.length === 0 ? [] : splat.split("/").map((segment) => encodeURIComponent(segment));
  const pathname = pathSegments.length === 0 ? "/streams/" : `/streams/${pathSegments.join("/")}`;
  return new URL(pathname, `${projectBase}/`).toString();
}
