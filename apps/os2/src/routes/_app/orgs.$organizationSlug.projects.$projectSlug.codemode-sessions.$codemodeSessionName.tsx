import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { Event } from "@iterate-com/events-contract";
import { StreamPath } from "@iterate-com/events-contract";
import {
  processEventsWithViewReducer,
  rawPrettyEventsStreamViewReducer,
} from "@iterate-com/ui/components/events/feed-processors";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { EventsStreamView } from "@iterate-com/ui/components/events/stream-feed";
import { z } from "zod";
import { createBrowserWebSocketClient, orpc } from "~/orpc/client.ts";

const Search = z.object({
  streamPath: StreamPath.optional(),
});

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/$codemodeSessionName",
)({
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
        ...orpc.projects.codemodeSessions.find.queryOptions({
          input: { name: params.codemodeSessionName, projectId: project.id },
        }),
        staleTime: 10_000,
      });

      return {
        breadcrumb: "Session",
        session,
      };
    } catch (error) {
      if (!search.streamPath) throw error;
      if (!search.streamPath.startsWith(`/projects/${project.id}/`)) throw error;

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
  const params = Route.useParams();
  const { session } = Route.useLoaderData();
  const [events, setEvents] = useState<Event[]>([]);
  const [openEventOffset, setOpenEventOffset] = useState<number | undefined>();
  const [isPending, setIsPending] = useState(true);
  const [errorLabel, setErrorLabel] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    const wsClient = createBrowserWebSocketClient({ organizationSlug: params.organizationSlug });
    let isCurrent = true;

    setEvents([]);
    setErrorLabel(undefined);
    setIsPending(true);

    void (async () => {
      try {
        const stream = await wsClient.client.codemode.streamEvents(
          {
            afterOffset: "start",
            streamPath: session.streamPath,
          },
          { signal: controller.signal },
        );

        if (!isCurrent || controller.signal.aborted) return;
        setIsPending(false);

        for await (const event of stream) {
          if (!isCurrent || controller.signal.aborted) return;
          setEvents((previous) => [...previous, event]);
        }
      } catch (error) {
        if (!isCurrent || controller.signal.aborted) return;
        setErrorLabel(error instanceof Error ? error.message : String(error));
        setIsPending(false);
      }
    })();

    return () => {
      isCurrent = false;
      controller.abort();
      wsClient.close();
    };
  }, [params.organizationSlug, session.streamPath]);

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
      <div className="border-b p-4">
        <div className="max-w-md space-y-1">
          <p className="font-mono text-xs text-muted-foreground">
            <EventsStreamPathLabel path={session.streamPath} />
          </p>
        </div>
      </div>
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
