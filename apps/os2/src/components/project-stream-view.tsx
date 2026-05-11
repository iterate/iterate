import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Event, EventInput, type StreamPath } from "@iterate-com/shared/streams/types";
import {
  processEventsWithViewReducer,
  selectEventsStreamViewReducer,
} from "@iterate-com/ui/components/events/feed-processors";
import type {
  EventsStreamInputAction,
  EventsStreamRegisteredProcessor,
} from "@iterate-com/ui/components/events/feed-items";
import {
  EventsStreamComposer,
  type EventsStreamComposerMode,
  type EventsStreamComposerRawPreset,
} from "@iterate-com/ui/components/events/stream-composer";
import {
  EventsStreamInputSlot,
  EventsStreamView,
  type EventsStreamElementType,
  type EventsStreamRendererMode,
} from "@iterate-com/ui/components/events/stream-feed";
import { EventsStreamLayoutMessageInput } from "@iterate-com/ui/components/events/stream-layout";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { EventsDebugLink } from "~/components/events-debug-link.tsx";
import { createBrowserOpenApiClient } from "~/orpc/client.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";

type ProjectStreamMessageComposer = {
  placeholder?: string;
  onSubmit: (message: string) => Promise<void>;
};

const DEFAULT_RAW_EVENT_PRESET_ID = "manual-event";

const defaultRawEventPresets: readonly EventsStreamComposerRawPreset[] = [
  {
    id: DEFAULT_RAW_EVENT_PRESET_ID,
    label: "Manual event",
    value: [
      "type: events.iterate.com/os2/manual-event",
      "payload:",
      "  message: Hello from the stream composer",
      "",
    ].join("\n"),
  },
  {
    id: "stream-error",
    label: "Stream error",
    value: [
      "type: events.iterate.com/core/error-occurred",
      "payload:",
      "  message: Something notable happened",
      "",
    ].join("\n"),
  },
  {
    id: "metadata-updated",
    label: "Metadata updated",
    value: [
      "type: events.iterate.com/core/metadata-updated",
      "payload:",
      "  metadata:",
      "    source: manual",
      "",
    ].join("\n"),
  },
];

export function ProjectStreamView({
  defaultComposerMode,
  emptyLabel = "No events in this stream yet.",
  headerAccessory,
  messageComposer,
  organizationSlug,
  projectSlug,
  projectSlugOrId,
  streamPath,
}: {
  defaultComposerMode?: EventsStreamComposerMode;
  emptyLabel?: string;
  headerAccessory?: ReactNode;
  messageComposer?: ProjectStreamMessageComposer;
  organizationSlug: string;
  projectSlug: string;
  projectSlugOrId: string;
  streamPath: StreamPath;
}) {
  const hasMessageComposer = messageComposer != null;
  const [composerText, setComposerText] = useState("");
  const [composerMode, setComposerMode] = useState<EventsStreamComposerMode>(
    defaultComposerMode ?? (hasMessageComposer ? "message" : "raw"),
  );
  const [rawComposerText, setRawComposerText] = useState(defaultRawEventPresets[0]?.value ?? "");
  const [selectedRawPresetId, setSelectedRawPresetId] = useState(DEFAULT_RAW_EVENT_PRESET_ID);
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

  const rawPresets = useMemo(
    () => buildRawPresets(viewState.activity.registeredProcessors),
    [viewState.activity.registeredProcessors],
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

  async function submitRawEvents() {
    const trimmed = rawComposerText.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    try {
      const inputEvents = parseRawEventInputs(trimmed);
      await createBrowserOpenApiClient().project.streams.appendBatch({
        events: inputEvents,
        projectSlugOrId,
        streamPath,
      });
    } catch (error) {
      setErrorLabel(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function selectRawPreset(presetId: string) {
    setSelectedRawPresetId(presetId);
    const preset = rawPresets.find((candidate) => candidate.id === presetId);
    if (preset != null) {
      setRawComposerText(preset.value);
    }
  }

  function handleInputAction(action: EventsStreamInputAction) {
    if (action.type === "prefill-agent-message") {
      setComposerText(action.text);
      setComposerMode("message");
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

      <EventsStreamLayoutMessageInput>
        <EventsStreamInputSlot
          className="mb-3"
          elements={viewState.slots.input}
          onAction={handleInputAction}
        />
        <EventsStreamComposer
          mode={composerMode}
          onModeChange={setComposerMode}
          message={
            hasMessageComposer
              ? {
                  value: composerText,
                  onValueChange: setComposerText,
                  onSubmit: submitMessage,
                  placeholder: messageComposer.placeholder ?? "Message this stream",
                }
              : undefined
          }
          raw={{
            value: rawComposerText,
            onValueChange: setRawComposerText,
            onSubmit: submitRawEvents,
            presets: rawPresets,
            selectedPresetId: selectedRawPresetId,
            onSelectedPresetIdChange: selectRawPreset,
          }}
          isSubmitting={isSubmitting}
        />
      </EventsStreamLayoutMessageInput>
    </section>
  );
}

function appendStreamEvent(events: Event[], event: Event): Event[] {
  if (events.some((candidate) => candidate.offset === event.offset)) return events;

  return [...events, event].toSorted((left, right) => left.offset - right.offset);
}

function parseRawEventInputs(value: string): EventInput[] {
  const parsed = parseYaml(value) as unknown;
  const inputEvents = Array.isArray(parsed) ? parsed : [parsed];

  return inputEvents.map((inputEvent) => EventInput.parse(inputEvent));
}

function buildRawPresets(
  processors: readonly EventsStreamRegisteredProcessor[],
): EventsStreamComposerRawPreset[] {
  const processorPresets: EventsStreamComposerRawPreset[] = [];

  for (const processor of processors) {
    for (const event of processor.ownedEvents) {
      if (event.examples == null || event.examples.length === 0) continue;

      for (const example of event.examples) {
        processorPresets.push({
          id: `${processor.slug}/${event.type}/${example.description}`,
          label: `${processor.slug}: ${example.description}`,
          value: stringifyYaml({ type: event.type, payload: example.payload }),
        });
      }
    }
  }

  return [...defaultRawEventPresets, ...processorPresets];
}
