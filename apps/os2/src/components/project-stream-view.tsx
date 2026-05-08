import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Event, type StreamPath } from "@iterate-com/shared/streams/types";
import {
  processEventsWithViewReducer,
  selectEventsStreamViewReducer,
} from "@iterate-com/ui/components/events/feed-processors";
import type { EventsStreamInputAction } from "@iterate-com/ui/components/events/feed-items";
import { EventsStreamComposer } from "@iterate-com/ui/components/events/stream-composer";
import {
  EventsStreamInputSlot,
  EventsStreamView,
  type EventsStreamElementType,
  type EventsStreamRendererMode,
} from "@iterate-com/ui/components/events/stream-feed";
import { EventsStreamLayoutMessageInput } from "@iterate-com/ui/components/events/stream-layout";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { EventsDebugLink } from "~/components/events-debug-link.tsx";
import { createBrowserOpenApiClient } from "~/orpc/client.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";

type ProjectStreamMessageComposer = {
  placeholder?: string;
  onSubmit: (message: string) => Promise<void>;
};

export function ProjectStreamView({
  emptyLabel = "No events in this stream yet.",
  headerAccessory,
  messageComposer,
  organizationSlug,
  projectSlug,
  projectSlugOrId,
  streamPath,
}: {
  emptyLabel?: string;
  headerAccessory?: ReactNode;
  messageComposer?: ProjectStreamMessageComposer;
  organizationSlug: string;
  projectSlug: string;
  projectSlugOrId: string;
  streamPath: StreamPath;
}) {
  const [composerText, setComposerText] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [errorLabel, setErrorLabel] = useState<string | undefined>();
  const [hiddenElementTypes, setHiddenElementTypes] = useState<EventsStreamElementType[]>([]);
  const [rendererMode, setRendererMode] = useState<EventsStreamRendererMode>("raw-pretty");
  const [isPending, setIsPending] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openEventOffset, setOpenEventOffset] = useState<number | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    let isCurrent = true;
    let iterator: AsyncIterator<Event> | undefined;

    setEvents([]);
    setErrorLabel(undefined);
    setIsPending(true);

    void (async () => {
      try {
        const stream = await createBrowserOpenApiClient().project.streams.streamEvents(
          {
            afterOffset: "start",
            projectSlugOrId,
            streamPath,
          },
          { signal: controller.signal },
        );
        iterator = stream[Symbol.asyncIterator]();

        if (!isCurrent || controller.signal.aborted) return;
        setIsPending(false);

        for await (const value of stream) {
          if (!isCurrent || controller.signal.aborted) return;
          const event = Event.parse(value);
          setEvents((previous) => appendStreamEvent(previous, event));
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
      void iterator?.return?.();
    };
  }, [projectSlugOrId, streamPath]);

  const viewState = useMemo(
    () =>
      processEventsWithViewReducer({
        events,
        reducer: selectEventsStreamViewReducer(rendererMode),
      }),
    [events, rendererMode],
  );

  async function submitMessage() {
    if (!messageComposer) return;
    const trimmed = composerText.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    try {
      await messageComposer.onSubmit(trimmed);
      setComposerText("");
    } catch (error) {
      setErrorLabel(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleInputAction(action: EventsStreamInputAction) {
    if (action.type === "prefill-agent-message") {
      setComposerText(action.text);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b p-4">
        <EventsStreamPathLabel path={streamPath} className="min-w-0 text-sm font-medium" />
        <EventsDebugLink
          className="md:shrink-0"
          namespace={projectSlugOrId}
          streamPath={streamPath}
        />
      </div>
      {headerAccessory == null ? null : <div className="shrink-0 border-b">{headerAccessory}</div>}

      <EventsStreamView
        className="min-h-0 flex-1"
        viewState={viewState}
        events={events}
        openEventOffset={openEventOffset}
        onOpenEventOffsetChange={setOpenEventOffset}
        renderStreamPathLink={({ path, children, className }) => (
          <Link
            className={className}
            to="/orgs/$organizationSlug/projects/$projectSlug/streams/$"
            params={{
              organizationSlug,
              projectSlug,
              _splat: streamPathToSplat(path),
            }}
          >
            {children}
          </Link>
        )}
        emptyLabel={emptyLabel}
        isPending={isPending}
        errorLabel={errorLabel}
        hiddenElementTypes={hiddenElementTypes}
        onHiddenElementTypesChange={setHiddenElementTypes}
        rendererMode={rendererMode}
        onRendererModeChange={setRendererMode}
      />

      {messageComposer ? (
        <EventsStreamLayoutMessageInput>
          <EventsStreamInputSlot
            className="mb-3"
            elements={viewState.slots.input}
            onAction={handleInputAction}
          />
          <EventsStreamComposer
            value={composerText}
            onValueChange={setComposerText}
            onSubmit={submitMessage}
            isSubmitting={isSubmitting}
            placeholder={messageComposer.placeholder ?? "Message this stream"}
          />
        </EventsStreamLayoutMessageInput>
      ) : null}
    </section>
  );
}

function appendStreamEvent(events: Event[], event: Event): Event[] {
  if (events.some((candidate) => candidate.offset === event.offset)) return events;

  return [...events, event].toSorted((left, right) => left.offset - right.offset);
}
