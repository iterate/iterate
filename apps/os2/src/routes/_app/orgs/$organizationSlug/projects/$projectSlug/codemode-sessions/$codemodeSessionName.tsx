import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { Event } from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@iterate-com/ui/components/collapsible";
import {
  processEventsWithViewReducer,
  rawPrettyEventsStreamViewReducer,
} from "@iterate-com/ui/components/events/feed-processors";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { EventsStreamView } from "@iterate-com/ui/components/events/stream-feed";
import { z } from "zod";
import { ExistingCodemodeSessionControls } from "~/components/codemode-session-controls.tsx";
import { orpc } from "~/orpc/client.ts";

const Search = z.object({
  streamPath: StreamPath.optional(),
});

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/$codemodeSessionName",
)({
  params: {
    parse: (raw) => ({
      codemodeSessionName: safeDecodeBase64Url(raw.codemodeSessionName),
    }),
    stringify: (parsed) => ({
      codemodeSessionName: encodeBase64Url(parsed.codemodeSessionName),
    }),
  },
  validateSearch: Search,
  ssr: false,
  loader: async ({ context, location, params }) => {
    const search = Search.parse(location.search);
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

    try {
      const session = await context.queryClient.ensureQueryData({
        ...orpc.project.codemode.findSession.queryOptions({
          input: { name: params.codemodeSessionName, projectSlugOrId: project.id },
        }),
        staleTime: 10_000,
      });

      return {
        breadcrumb: "Session",
        session,
      };
    } catch (error) {
      if (!search.streamPath) throw error;
      if (search.streamPath.startsWith("/projects/")) throw error;

      return {
        breadcrumb: "Session",
        session: {
          name: params.codemodeSessionName,
          projectId: project.id,
          streamPath: search.streamPath,
          createdAt: new Date().toISOString(),
          lastWokenAt: new Date().toISOString(),
        },
      };
    }
  },
  component: CodemodeSessionPage,
});

function CodemodeSessionPage() {
  const { session } = Route.useLoaderData();
  const [events, setEvents] = useState<Event[]>([]);
  const [openEventOffset, setOpenEventOffset] = useState<number | undefined>();
  const [isPending, setIsPending] = useState(true);
  const [errorLabel, setErrorLabel] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    let isCurrent = true;

    setEvents([]);
    setErrorLabel(undefined);
    setIsPending(true);

    void (async () => {
      try {
        for await (const event of streamCodemodeEvents({
          projectId: session.projectId,
          signal: controller.signal,
          streamPath: session.streamPath,
        })) {
          if (!isCurrent || controller.signal.aborted) return;
          setIsPending(false);
          setEvents((previous) => [...previous, event]);
        }

        if (!isCurrent || controller.signal.aborted) return;
        setIsPending(false);
      } catch (error) {
        if (!isCurrent || controller.signal.aborted) return;
        setErrorLabel(error instanceof Error ? error.message : String(error));
        setIsPending(false);
      }
    })();

    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [session.projectId, session.streamPath]);

  const viewState = useMemo(
    () =>
      processEventsWithViewReducer({
        events,
        reducer: rawPrettyEventsStreamViewReducer,
      }),
    [events],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <Collapsible defaultOpen={false} className="border-b">
        <div className="flex items-center gap-2 p-4">
          <p className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
            <EventsStreamPathLabel path={session.streamPath} />
          </p>
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm">
                <ChevronRight className="size-4 transition-transform [[data-panel-open]_&]:rotate-90" />
                Append event
              </Button>
            }
          />
        </div>
        <CollapsibleContent>
          <div className="w-full max-w-7xl space-y-4 px-4 pb-4">
            <ExistingCodemodeSessionControls
              projectId={session.projectId}
              streamPath={session.streamPath}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
      <EventsStreamView
        className="min-h-0 flex-1"
        viewState={viewState}
        events={events}
        openEventOffset={openEventOffset}
        onOpenEventOffsetChange={setOpenEventOffset}
        emptyLabel="No events in this codemode session yet"
        isPending={isPending}
        errorLabel={errorLabel}
      />
    </section>
  );
}

async function* streamCodemodeEvents(input: {
  projectId: string;
  signal: AbortSignal;
  streamPath: StreamPath;
}): AsyncGenerator<Event> {
  const url = new URL(
    `/api/projects/${encodeURIComponent(input.projectId)}/codemode-events/${encodeURIComponent(
      input.streamPath,
    )}`,
    window.location.origin,
  );
  url.searchParams.set("afterOffset", "start");

  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "text/event-stream" },
    signal: input.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body.trim() || `Could not open stream (${response.status})`);
  }
  if (!response.body) throw new Error("Could not open stream: response body is empty");

  yield* decodeCodemodeEventStream(response.body, input.signal);
}

async function* decodeCodemodeEventStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Event> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel();
  };

  try {
    signal.addEventListener("abort", onAbort, { once: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const result = drainCodemodeEventBuffer(buffer);
      buffer = result.remaining;
      for (const event of result.events) yield event;
    }

    buffer += decoder.decode();
    for (const event of drainCodemodeEventBuffer(buffer, true).events) yield event;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function drainCodemodeEventBuffer(buffer: string, flush = false) {
  const events: Event[] = [];
  let remaining = buffer;

  while (true) {
    const frameEnd = remaining.indexOf("\n\n");
    if (frameEnd === -1) break;

    const frame = remaining.slice(0, frameEnd);
    remaining = remaining.slice(frameEnd + 2);
    if (!frame.trim()) continue;
    const event = parseCodemodeEventFrame(frame);
    if (event) events.push(event);
  }

  while (true) {
    const newlineIndex = remaining.indexOf("\n");
    if (newlineIndex === -1) break;

    const line = remaining.slice(0, newlineIndex).trim();
    if (!line) {
      remaining = remaining.slice(newlineIndex + 1);
      continue;
    }
    if (!line.startsWith("{")) break;

    remaining = remaining.slice(newlineIndex + 1);
    events.push(JSON.parse(line) as Event);
  }

  if (flush && remaining.trim()) {
    const tail = remaining.trim();
    remaining = "";
    const event = tail.startsWith("{")
      ? (JSON.parse(tail) as Event)
      : parseCodemodeEventFrame(tail);
    if (event) events.push(event);
  }

  return { events, remaining };
}

function parseCodemodeEventFrame(frame: string): Event | null {
  let name = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalizedLine.startsWith("event:")) {
      name = normalizedLine.slice("event:".length).trim();
    } else if (normalizedLine.startsWith("data:")) {
      dataLines.push(normalizedLine.slice("data:".length).trimStart());
    }
  }

  const data = dataLines.join("\n");
  if (name === "error") {
    throw new Error(data || "Could not open stream");
  }
  if (!data) return null;

  return JSON.parse(data) as Event;
}

function encodeBase64Url(value: string): string {
  return btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(base64)));
}

/** Decode base64url, falling back to the raw value for old-style URLs. */
function safeDecodeBase64Url(value: string): string {
  try {
    return decodeBase64Url(value);
  } catch {
    return value;
  }
}
