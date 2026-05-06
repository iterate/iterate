import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BugIcon, DatabaseIcon, ExternalLinkIcon } from "lucide-react";
import {
  type Event,
  type EventInput,
  type JSONObject,
  STREAM_CHILD_STREAM_CREATED_TYPE,
  type StreamPath,
  type StreamState,
} from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import {
  processEventsWithViewReducer,
  rawJsonDumpEventsStreamViewReducer,
  rawPrettyEventsStreamViewReducer,
} from "@iterate-com/ui/components/events/feed-processors";
import type {
  EventsStreamInputAction,
  EventsStreamViewReducer,
} from "@iterate-com/ui/components/events/feed-items";
import { EventsStreamEventInspectorSheet } from "@iterate-com/ui/components/events/event-inspector-sheet";
import {
  EventsStreamFeed,
  type EventsStreamElementType,
  EventsStreamHeader,
  EventsStreamInputSlot,
} from "@iterate-com/ui/components/events/stream-feed";
import {
  EventsStreamLayout,
  EventsStreamLayoutHeader,
  EventsStreamLayoutMain,
  EventsStreamLayoutMessageInput,
} from "@iterate-com/ui/components/events/stream-layout";
import { Label } from "@iterate-com/ui/components/label";
import { Separator } from "@iterate-com/ui/components/separator";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import { stringify as stringifyYaml } from "yaml";
import { StreamEventFeed, type CustomHtmlRendererApi } from "~/components/stream-event-feed.tsx";
import { StreamComposer } from "~/components/stream-composer.tsx";
import { useLiveStreamEvents } from "~/hooks/use-live-stream-events.ts";
import { getEventInputTemplateById, getProcessorEventDocByType } from "~/lib/processor-docs.ts";
import { parseObjectFromComposerText } from "~/lib/stream-composer-input.ts";
import {
  buildCustomHtmlRendererProjection,
  type CustomHtmlRendererProjection,
} from "~/lib/custom-html-renderers.ts";
import { buildDisplayFeed, projectWireToFeed } from "~/lib/stream-feed-projection.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import {
  DEFAULT_STREAM_RENDERER_MODE,
  type StreamFeedItem,
  type StreamRendererMode,
} from "~/lib/stream-feed-types.ts";
import { formatClientError } from "~/lib/format-client-error.ts";
import { defaultProjectId, resolveHostProjectId } from "~/lib/project-id.ts";
import {
  defaultStreamViewSearch,
  type StreamComposerMode,
  type StreamFeedViewMode,
} from "~/lib/stream-view-search.ts";
import { getOrpc, getOrpcClient } from "~/orpc/client.ts";
import { useStreamsChrome } from "~/components/streams-chrome.tsx";

const DEFAULT_EVENT_TEMPLATE_ID = "core:durable-object-woke-up";
const EMPTY_CUSTOM_INSERTIONS = new Map<number, StreamFeedItem[]>();

export function StreamPage({
  streamPath,
  rendererMode = DEFAULT_STREAM_RENDERER_MODE,
  composerMode = defaultStreamViewSearch.composer,
  feedViewMode = defaultStreamViewSearch.view,
  hiddenElementTypes = defaultStreamViewSearch.hiddenElements,
  openEventOffset,
  onOpenEventOffsetChange,
  onRendererModeChange,
  onComposerModeChange,
  onFeedViewModeChange,
  onHiddenElementTypesChange,
}: {
  streamPath: StreamPath;
  rendererMode?: StreamRendererMode;
  composerMode?: StreamComposerMode;
  feedViewMode?: StreamFeedViewMode;
  hiddenElementTypes?: readonly EventsStreamElementType[];
  openEventOffset?: number;
  onOpenEventOffsetChange?: (offset?: number) => void;
  onRendererModeChange?: (mode: StreamRendererMode) => void;
  onComposerModeChange?: (mode: StreamComposerMode) => void;
  onFeedViewModeChange?: (mode: StreamFeedViewMode) => void;
  onHiddenElementTypesChange?: (types: EventsStreamElementType[]) => void;
}) {
  const queryClient = useQueryClient();
  const { closeMetadata, metadataOpen, setHeaderControls } = useStreamsChrome();
  const orpc = getOrpc();
  const [selectedTemplateId, setSelectedTemplateId] = useState(DEFAULT_EVENT_TEMPLATE_ID);
  const [appendInputJson, setAppendInputJson] = useState(() =>
    createEventInputTemplate(DEFAULT_EVENT_TEMPLATE_ID, "json"),
  );
  const [appendInputYaml, setAppendInputYaml] = useState(() =>
    createEventInputTemplate(DEFAULT_EVENT_TEMPLATE_ID, "yaml"),
  );
  const [agentInputText, setAgentInputText] = useState("");
  const streamStateOptions = useMemo(
    () => orpc.getState.queryOptions({ input: { path: streamPath } }),
    [orpc, streamPath],
  );
  const listChildrenOptions = useMemo(
    () => orpc.listChildren.queryOptions({ input: { path: "/" } }),
    [orpc],
  );

  const streamStateQuery = useQuery({
    ...streamStateOptions,
    staleTime: 5_000,
  });

  const {
    events,
    isConnecting,
    status: liveStreamStatus,
  } = useLiveStreamEvents({
    streamPath,
    onEvent: useCallback(
      (event: Event) => {
        if (streamPath === "/" && event.type === STREAM_CHILD_STREAM_CREATED_TYPE) {
          void queryClient.invalidateQueries({ queryKey: listChildrenOptions.queryKey });
        }
      },
      [listChildrenOptions.queryKey, queryClient, streamPath],
    ),
  });
  const eventProjectionKey = useMemo(
    () => events.map((event) => `${event.offset}:${event.type}:${event.createdAt}`).join("|"),
    [events],
  );
  const customHtmlRendererProjectionRef = useRef<{
    streamPath: StreamPath;
    projection: CustomHtmlRendererProjection;
  } | null>(null);
  const customHtmlInsertionsQuery = useQuery({
    queryKey: ["custom-html-renderers", streamPath, eventProjectionKey],
    queryFn: async ({ signal }) => {
      const projection = await buildCustomHtmlRendererProjection({
        events,
        previousProjection:
          customHtmlRendererProjectionRef.current?.streamPath === streamPath
            ? customHtmlRendererProjectionRef.current.projection
            : undefined,
        signal,
      });
      customHtmlRendererProjectionRef.current = { streamPath, projection };
      return projection.insertionsByOffset;
    },
    placeholderData: (previous) => previous ?? EMPTY_CUSTOM_INSERTIONS,
  });
  const feed = useMemo(
    () =>
      projectWireToFeed(events, {
        customInsertionsByOffset: customHtmlInsertionsQuery.data ?? EMPTY_CUSTOM_INSERTIONS,
      }),
    [customHtmlInsertionsQuery.data, events],
  );
  const displayFeed = useMemo(() => buildDisplayFeed(feed, rendererMode), [feed, rendererMode]);
  // In the clean feed, renderer modes select stream-view reducers. Rendering
  // stays mode-agnostic and only switches on each feed item's `type`.
  const cleanViewState = useMemo(
    () => reduceCleanViewState({ events, mode: rendererMode }),
    [events, rendererMode],
  );
  const onRendererModeChangeRef = useRef(onRendererModeChange);
  const onFeedViewModeChangeRef = useRef(onFeedViewModeChange);
  onRendererModeChangeRef.current = onRendererModeChange;
  onFeedViewModeChangeRef.current = onFeedViewModeChange;
  /*
   * Header controls live in the surrounding streams chrome, but their actions
   * are owned by this route. Keep the callbacks stable so publishing controls
   * into context does not retrigger itself through a provider rerender.
   */
  const handleHeaderRendererModeChange = useCallback((mode: StreamRendererMode) => {
    onRendererModeChangeRef.current?.(mode);
  }, []);
  const handleHeaderFeedViewModeChange = useCallback((mode: StreamFeedViewMode) => {
    onFeedViewModeChangeRef.current?.(mode);
  }, []);
  const headerControls = useMemo(
    () => ({
      rendererMode,
      onRendererModeChange: handleHeaderRendererModeChange,
      feedViewMode,
      onFeedViewModeChange: handleHeaderFeedViewModeChange,
    }),
    [feedViewMode, handleHeaderFeedViewModeChange, handleHeaderRendererModeChange, rendererMode],
  );
  const publishedHeaderControlsRef = useRef<typeof headerControls | null>(null);

  useEffect(() => {
    setAppendInputJson(createEventInputTemplate(selectedTemplateId, "json"));
    setAppendInputYaml(createEventInputTemplate(selectedTemplateId, "yaml"));
  }, [selectedTemplateId]);

  useEffect(() => {
    const previous = publishedHeaderControlsRef.current;
    if (
      previous?.rendererMode === headerControls.rendererMode &&
      previous?.feedViewMode === headerControls.feedViewMode &&
      previous?.onRendererModeChange === headerControls.onRendererModeChange &&
      previous?.onFeedViewModeChange === headerControls.onFeedViewModeChange
    ) {
      return;
    }

    /*
     * This effect bridges route-owned stream state into the app chrome. Compare
     * the meaningful fields before publishing so harmless object churn from
     * replaying the feed cannot create an update loop.
     */
    publishedHeaderControlsRef.current = headerControls;
    setHeaderControls(headerControls);
  }, [headerControls, setHeaderControls]);

  useEffect(() => {
    return () => {
      publishedHeaderControlsRef.current = null;
      setHeaderControls(null);
    };
  }, [setHeaderControls]);

  const [destroyChildren, setDestroyChildren] = useState(true);

  const appendEvent = useMutation(
    orpc.append.mutationOptions({
      onSuccess: async () => {
        void queryClient.invalidateQueries({ queryKey: listChildrenOptions.queryKey });
        await queryClient.invalidateQueries({ queryKey: streamStateOptions.queryKey });
      },
    }),
  );
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  const rendererApi = useMemo<CustomHtmlRendererApi>(
    () => ({
      streamPath,
      get events() {
        return eventsRef.current;
      },
      append: async (event: EventInput) => {
        const result = await getOrpcClient().append({
          path: streamPath,
          event,
        });
        void queryClient.invalidateQueries({ queryKey: listChildrenOptions.queryKey });
        await queryClient.invalidateQueries({ queryKey: streamStateOptions.queryKey });
        return result.event;
      },
      getState: () => getOrpcClient().getState({ path: streamPath }) as Promise<StreamState>,
      history: async () => {
        const historyStream = await getOrpcClient().stream({
          path: streamPath,
          beforeOffset: "end",
        });
        const historyEvents: Event[] = [];
        for await (const event of historyStream) {
          historyEvents.push(event);
        }
        return historyEvents;
      },
    }),
    [listChildrenOptions.queryKey, queryClient, streamPath, streamStateOptions.queryKey],
  );

  const resetStream = useMutation(
    orpc.destroy.mutationOptions({
      onSuccess: () => {
        closeMetadata();
        window.location.reload();
      },
    }),
  );
  const submitAppendEvent = async ({ event }: { event: EventInput }) => {
    try {
      await appendEvent.mutateAsync({
        path: streamPath,
        event,
      });
    } catch (error) {
      toast.error(formatClientError(error));
    }
  };

  const submitRawAppend = async ({
    inputText,
    format,
  }: {
    inputText: string;
    format: "json" | "yaml";
  }) => {
    let event: EventInput;

    try {
      event = parseAppendEventInput(inputText, format);
    } catch (error) {
      toast.error(formatClientError(error));
      return;
    }

    await submitAppendEvent({ event });
  };

  const submitAgentAppend = async ({ inputText }: { inputText: string }) => {
    const content = inputText.trim();

    if (content.length === 0) {
      toast.error("Enter a message");
      return;
    }

    await submitAppendEvent({
      event: {
        type: "events.iterate.com/webchat/user-message-added",
        payload: {
          content,
        },
      },
    });
    setAgentInputText("");
  };

  const submitDebugInfoRequest = async () => {
    await submitAppendEvent({
      event: {
        type: "debug-info-requested",
        payload: {},
      },
    });
  };

  const handleComposerSubmit = async () => {
    if (composerMode === "agent") {
      await submitAgentAppend({ inputText: agentInputText });
      return;
    }

    if (composerMode === "yaml") {
      await submitRawAppend({ inputText: appendInputYaml, format: "yaml" });
      return;
    }

    await submitRawAppend({ inputText: appendInputJson, format: "json" });
  };
  const handleInputSlotAction = (action: EventsStreamInputAction) => {
    switch (action.type) {
      case "prefill-agent-message":
        setAgentInputText(action.text);
        onComposerModeChange?.("agent");
        break;
    }
  };
  const liveStreamFailureLabel = getLiveStreamFailureLabel({
    isPending: isConnecting,
    liveStreamStatus,
  });
  const debugLinks = getStreamDebugLinks(streamPath);

  return (
    <EventsStreamLayout>
      {feedViewMode === "clean" &&
      (cleanViewState.slots.header.length > 0 || cleanViewState.slots.feed.length > 0) ? (
        <EventsStreamLayoutHeader>
          <EventsStreamHeader
            elements={cleanViewState.slots.header}
            elementTypes={[
              ...new Set(cleanViewState.slots.feed.map((element) => element.type)),
            ].sort()}
            hiddenElementTypes={hiddenElementTypes}
            onHiddenElementTypesChange={onHiddenElementTypesChange}
          />
        </EventsStreamLayoutHeader>
      ) : null}

      <EventsStreamLayoutMain>
        {feedViewMode === "clean" ? (
          <EventsStreamFeed
            elements={cleanViewState.slots.feed.filter(
              (element) => !hiddenElementTypes.includes(element.type),
            )}
            emptyLabel="No events received yet."
            isPending={isConnecting}
            errorLabel={liveStreamFailureLabel}
            onOpenEventOffsetChange={onOpenEventOffsetChange}
            renderStreamPathLink={({ path, children, className }) => (
              <Link
                to="/streams/$/"
                params={{ _splat: streamPathToSplat(path) }}
                search={(previous: typeof defaultStreamViewSearch) => ({
                  event: undefined,
                  composer: previous.composer ?? defaultStreamViewSearch.composer,
                  renderer: previous.renderer ?? defaultStreamViewSearch.renderer,
                  view: previous.view ?? defaultStreamViewSearch.view,
                  hiddenElements: previous.hiddenElements ?? defaultStreamViewSearch.hiddenElements,
                })}
                className={className}
              >
                {children}
              </Link>
            )}
          />
        ) : (
          <StreamEventFeed
            feed={feed}
            displayFeed={displayFeed}
            rendererMode={rendererMode}
            emptyLabel="No events received yet."
            isPending={isConnecting}
            liveStreamStatus={liveStreamStatus}
            openEventOffset={openEventOffset}
            onOpenEventOffsetChange={onOpenEventOffsetChange}
            rendererApi={rendererApi}
          />
        )}
      </EventsStreamLayoutMain>

      {feedViewMode === "clean" ? (
        <EventsStreamEventInspectorSheet
          events={events}
          openEventOffset={openEventOffset}
          onOpenEventOffsetChange={onOpenEventOffsetChange}
          getEventTypeHref={(eventType) => getProcessorEventDocByType(eventType)?.href}
        />
      ) : null}

      <Sheet
        open={metadataOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeMetadata();
          }
        }}
      >
        <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(96vw,120rem)] data-[side=right]:sm:max-w-[min(96vw,120rem)]">
          <SheetHeader className="space-y-2 border-b pr-14">
            <SheetTitle>Stream info</SheetTitle>
            <SheetDescription>
              This is the reduced state inside the stream durable object, as returned from
              `getState`.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-destructive">Reset stream</p>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Clears durable state — cannot be undone.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:justify-end">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="reset-child-streams"
                      checked={destroyChildren}
                      onCheckedChange={(checked) => setDestroyChildren(checked)}
                    />
                    <Label htmlFor="reset-child-streams" className="text-xs leading-none">
                      Reset child streams
                    </Label>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-8 shrink-0 px-3 text-xs"
                    disabled={resetStream.isPending}
                    onClick={() => {
                      const request = resetStream.mutateAsync({
                        params: { path: streamPath },
                        query: { destroyChildren },
                      });
                      void toast.promise(request, {
                        loading: "Resetting stream…",
                        success: (result) =>
                          `Reset ${result.destroyedStreamCount} stream${result.destroyedStreamCount === 1 ? "" : "s"}`,
                        error: (error) => formatClientError(error),
                      });
                    }}
                  >
                    {resetStream.isPending ? "Resetting…" : "Reset"}
                  </Button>
                </div>
              </div>
            </div>

            <Separator className="my-4" />

            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-2 px-3 text-xs"
                render={<a href={debugLinks.kv} target="_blank" rel="noreferrer" />}
              >
                <BugIcon className="size-3.5" />
                __kv
                <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-2 px-3 text-xs"
                render={<a href={debugLinks.outerbase} target="_blank" rel="noreferrer" />}
              >
                <DatabaseIcon className="size-3.5" />
                Outerbase
                <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
              </Button>
            </div>

            <SerializedObjectCodeBlock
              data={streamStateQuery.data ?? null}
              className="min-h-80"
              initialFormat="yaml"
              showToggle
              showCopyButton
            />
          </div>
        </SheetContent>
      </Sheet>

      <EventsStreamLayoutMessageInput>
        {/* Input-slot elements are reducer output. This is the proof point that
            stream events can draw affordances into the composer region without
            the reducer owning the app-specific composer implementation. */}
        {feedViewMode === "clean" ? (
          <EventsStreamInputSlot
            elements={cleanViewState.slots.input}
            onAction={handleInputSlotAction}
            className="mb-3"
          />
        ) : null}

        <StreamComposer
          composerMode={composerMode}
          onComposerModeChange={onComposerModeChange}
          selectedTemplateId={selectedTemplateId}
          onSelectedTemplateIdChange={setSelectedTemplateId}
          agentInputText={agentInputText}
          onAgentInputTextChange={setAgentInputText}
          appendInputJson={appendInputJson}
          onAppendInputJsonChange={setAppendInputJson}
          appendInputYaml={appendInputYaml}
          onAppendInputYamlChange={setAppendInputYaml}
          isSubmitting={appendEvent.isPending}
          onSubmit={handleComposerSubmit}
          onDebugInfoRequest={submitDebugInfoRequest}
        />
      </EventsStreamLayoutMessageInput>
    </EventsStreamLayout>
  );
}

function createEventInputTemplate(templateId: string, format: "json" | "yaml") {
  const template =
    getEventInputTemplateById(templateId) ?? getEventInputTemplateById(DEFAULT_EVENT_TEMPLATE_ID);

  const data = JSON.parse(JSON.stringify(template?.event ?? {})) as JSONObject;

  return format === "yaml" ? stringifyYaml(data) : JSON.stringify(data, null, 2);
}

function parseAppendEventInput(value: string, format: "json" | "yaml") {
  return parseObjectFromComposerText(value, format) as EventInput;
}

function getLiveStreamFailureLabel({
  isPending,
  liveStreamStatus,
}: {
  isPending: boolean;
  liveStreamStatus?: string;
}) {
  if (isPending || liveStreamStatus == null) {
    return undefined;
  }

  return liveStreamStatus.startsWith("Error:") || liveStreamStatus.startsWith("Timed out")
    ? liveStreamStatus
    : undefined;
}

function getStreamDebugLinks(streamPath: StreamPath) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const hostname = typeof window === "undefined" ? null : window.location.hostname;
  const projectId = resolveHostProjectId(hostname) ?? defaultProjectId;
  const initParams = encodeURIComponent(JSON.stringify({ projectId, path: streamPath }));
  const base = `${origin}/durable-objects/stream/by-init-params/${initParams}`;

  return {
    kv: `${base}/__kv`,
    outerbase: `${base}/__outerbase`,
  };
}

function reduceCleanViewState(args: { events: readonly Event[]; mode: StreamRendererMode }) {
  return processEventsWithViewReducer({
    events: args.events,
    reducer: selectCleanViewReducer(args.mode),
  });
}

function selectCleanViewReducer(mode: StreamRendererMode): EventsStreamViewReducer {
  switch (mode) {
    case "raw-pretty":
      return rawPrettyEventsStreamViewReducer;
    case "raw-single-json":
      return rawJsonDumpEventsStreamViewReducer;
    case "raw":
    case "pretty":
      return rawPrettyEventsStreamViewReducer;
  }
}
