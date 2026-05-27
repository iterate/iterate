import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Event, EventInput, type StreamPath } from "@iterate-com/shared/streams/types";
import {
  getInitialProcessorState,
  runProcessorReduce,
  type ProcessorState,
  type StreamEvent,
} from "@iterate-com/shared/stream-processors";
import { StreamViewProcessorContract } from "@iterate-com/ui/components/events/stream-view-processor/contract";
import type {
  EventsStreamInputAction,
  EventsStreamRegisteredProcessor,
  EventsStreamViewState,
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
    processorSlug: "manual",
    eventType: "events.iterate.com/os/manual-event",
    eventDescription: "A generic event you can edit before appending it to the stream.",
    exampleName: "Manual event",
    value: [
      "type: events.iterate.com/os/manual-event",
      "payload:",
      "  message: Hello from the stream composer",
      "",
    ].join("\n"),
  },
  {
    id: "stream-error",
    label: "Stream error",
    processorSlug: "core",
    eventType: "events.iterate.com/core/error-occurred",
    eventDescription: "Records a stream-level error that can be surfaced in the stream UI.",
    eventDocsHref: "https://events.iterate.com/core/error-occurred/",
    exampleName: "Stream error",
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
    processorSlug: "core",
    eventType: "events.iterate.com/core/metadata-updated",
    eventDescription: "Updates metadata associated with this stream.",
    eventDocsHref: "https://events.iterate.com/core/metadata-updated/",
    exampleName: "Metadata updated",
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
  projectSlug,
  projectSlugOrId,
  streamPath,
}: {
  defaultComposerMode?: EventsStreamComposerMode;
  emptyLabel?: string;
  headerAccessory?: ReactNode;
  messageComposer?: ProjectStreamMessageComposer;
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

  const processorRef = useRef<{
    state: ProcessorState<typeof StreamViewProcessorContract>;
    processedCount: number;
  }>({
    state: getInitialProcessorState(StreamViewProcessorContract),
    processedCount: 0,
  });

  const processorState = useMemo(() => {
    const ref = processorRef.current;

    // Reset when events are cleared (stream path change)
    if (ref.processedCount > events.length) {
      ref.state = getInitialProcessorState(StreamViewProcessorContract);
      ref.processedCount = 0;
    }

    // Incremental reduce — only process new events
    const processor = { contract: StreamViewProcessorContract };
    for (let i = ref.processedCount; i < events.length; i++) {
      const reduction = runProcessorReduce({
        processor,
        event: events[i] as unknown as StreamEvent,
        state: ref.state,
      });
      ref.state = reduction?.state ?? ref.state;
    }
    ref.processedCount = events.length;
    return ref.state;
  }, [events]);

  // Renderer mode is a pure view-time filter — no re-processing needed
  const viewState = useMemo((): EventsStreamViewState => {
    if (rendererMode === "raw-single-json") {
      return {
        ...processorState,
        slots: {
          ...processorState.slots,
          feed:
            events.length === 0
              ? []
              : [
                  {
                    type: "raw-json-dump",
                    id: "raw-json-dump",
                    props: { events: [...events] },
                  },
                ],
        },
      };
    }

    if (rendererMode === "pretty") {
      return {
        ...processorState,
        slots: {
          ...processorState.slots,
          feed: processorState.slots.feed.filter((element) => element.type !== "grouped-raw-event"),
        },
      };
    }

    // raw-pretty: show everything
    return processorState;
  }, [processorState, rendererMode, events]);

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
            to="/projects/$projectSlug/streams/$"
            params={{
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
  const lastEvent = events[events.length - 1];

  // Fast path: event arrives in order (the normal SSE case)
  if (lastEvent == null || event.offset > lastEvent.offset) {
    return [...events, event];
  }

  // Duplicate
  if (event.offset === lastEvent.offset) return events;
  if (events.some((candidate) => candidate.offset === event.offset)) return events;

  // Out-of-order fallback
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
      if (event.examples != null && event.examples.length > 0) {
        for (const example of event.examples) {
          processorPresets.push({
            id: `${processor.slug}/${event.type}/${example.description}`,
            label: `${shortEventType(event.type)}: ${example.description}`,
            processorSlug: processor.slug,
            eventType: event.type,
            ...(event.description == null ? {} : { eventDescription: event.description }),
            eventDocsHref: eventDocsHref({
              processorSlug: processor.slug,
              eventType: event.type,
            }),
            exampleName: example.description,
            value: stringifyYaml({ type: event.type, payload: example.payload }),
          });
        }
      } else {
        processorPresets.push({
          id: `${processor.slug}/${event.type}`,
          label: `${shortEventType(event.type)}: Empty payload`,
          processorSlug: processor.slug,
          eventType: event.type,
          ...(event.description == null ? {} : { eventDescription: event.description }),
          eventDocsHref: eventDocsHref({
            processorSlug: processor.slug,
            eventType: event.type,
          }),
          exampleName: "Empty payload",
          value: stringifyYaml({ type: event.type, payload: {} }),
        });
      }
    }
  }

  return [...defaultRawEventPresets, ...processorPresets];
}

function shortEventType(eventType: string): string {
  const lastSegment = eventType.split("/").pop();
  return lastSegment ?? eventType;
}

function eventDocsHref(args: { processorSlug: string; eventType: string }) {
  const prefix = `events.iterate.com/${args.processorSlug}/`;
  const eventSlug = args.eventType.startsWith(prefix)
    ? args.eventType.slice(prefix.length)
    : (args.eventType.split("/").at(-1) ?? args.eventType);
  return `https://events.iterate.com/${args.processorSlug}/${eventSlug}/`;
}
