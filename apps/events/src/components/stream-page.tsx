import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Event,
  EventInput,
  type EventType,
  type JSONObject,
  type StreamPath,
} from "@iterate-com/events-contract";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@iterate-com/ui/components/ai-elements/prompt-input";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import { StreamEventFeed } from "~/components/stream-event-feed.tsx";
import { useLiveStreamEvents } from "~/hooks/use-live-stream-events.ts";
import { eventTypePages, getEventTypePageByType } from "~/lib/event-type-pages.ts";
import { buildDisplayFeed, projectWireToFeed } from "~/lib/stream-feed-projection.ts";
import { summarizeStreamFeed } from "~/lib/stream-feed-summary.ts";
import { DEFAULT_STREAM_RENDERER_MODE, type StreamRendererMode } from "~/lib/stream-feed-types.ts";
import { formatClientError } from "~/lib/format-client-error.ts";
import { ROOT_STREAM_PATH } from "~/lib/utils.ts";
import { orpc } from "~/orpc/client.ts";
import { useStreamsChrome } from "~/components/streams-chrome.tsx";

const DEFAULT_EVENT_TYPE = "https://events.iterate.com/manual-event-appended";

export function StreamPage({
  streamPath,
  rendererMode = DEFAULT_STREAM_RENDERER_MODE,
  openEventOffset,
  onOpenEventOffsetChange,
  onRendererModeChange,
}: {
  streamPath: StreamPath;
  rendererMode?: StreamRendererMode;
  openEventOffset?: string;
  onOpenEventOffsetChange?: (offset?: string) => void;
  onRendererModeChange?: (mode: StreamRendererMode) => void;
}) {
  const queryClient = useQueryClient();
  const { closeMetadata, metadataOpen, setHeaderControls } = useStreamsChrome();
  const [selectedTemplateType, setSelectedTemplateType] = useState<EventType>(DEFAULT_EVENT_TYPE);
  const [appendInputJson, setAppendInputJson] = useState("");

  const streamStateQuery = useQuery({
    ...orpc.getState.queryOptions({ input: { streamPath } }),
    staleTime: 5_000,
  });

  const { events, isConnecting } = useLiveStreamEvents({
    streamPath,
    onEvent: useCallback(
      (event: Event) => {
        if (
          streamPath === ROOT_STREAM_PATH &&
          event.type === "https://events.iterate.com/events/stream/initialized"
        ) {
          void queryClient.invalidateQueries({ queryKey: orpc.listStreams.key() });
        }
      },
      [queryClient, streamPath],
    ),
  });
  const feed = useMemo(() => projectWireToFeed(events), [events]);
  const displayFeed = useMemo(() => buildDisplayFeed(feed, rendererMode), [feed, rendererMode]);
  const feedSummary = useMemo(() => summarizeStreamFeed(feed), [feed]);

  useEffect(() => {
    // The header lives in the parent `_app` layout, outside the concrete stream
    // route component, so we bridge the validated route search state into that
    // header here instead of duplicating local renderer state in the page.
    setHeaderControls({
      rendererMode,
      onRendererModeChange,
      feedSummary,
    });

    return () => {
      setHeaderControls(null);
    };
  }, [feedSummary, onRendererModeChange, rendererMode, setHeaderControls]);

  const appendEvent = useMutation(
    orpc.append.mutationOptions({
      onSuccess: async () => {
        void queryClient.invalidateQueries({ queryKey: orpc.listStreams.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.getState.key() });
      },
    }),
  );

  const selectedTemplatePage = getEventTypePageByType(selectedTemplateType);

  const submitAppend = async (inputText = appendInputJson) => {
    let event: EventInput;

    try {
      event = EventInput.parse(parseJSONObject(inputText));
    } catch (error) {
      toast.error(formatClientError(error));
      return;
    }

    const request = appendEvent.mutateAsync({
      path: streamPath,
      ...event,
    });

    void toast.promise(request, {
      loading: "Appending event",
      success: "Event appended",
      error: (error) => formatClientError(error),
    });

    await request.catch(() => undefined);
  };

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <StreamEventFeed
          feed={feed}
          displayFeed={displayFeed}
          rendererMode={rendererMode}
          emptyLabel="No events received yet."
          isPending={isConnecting || (streamStateQuery.isPending && events.length === 0)}
          openEventOffset={openEventOffset}
          onOpenEventOffsetChange={onOpenEventOffsetChange}
        />
      </div>

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

      <footer className="supports-backdrop-filter:bg-background/80 shrink-0 border-t bg-background/95 px-4 py-4">
        <PromptInput
          className="relative w-full"
          onSubmit={async ({ text }) => {
            await submitAppend(text);
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea
              value={appendInputJson}
              onChange={(event) => setAppendInputJson(event.currentTarget.value)}
              className="min-h-36 max-h-[45vh] font-mono text-xs leading-5"
              placeholder={
                selectedTemplatePage
                  ? `Enter JSON for ${selectedTemplatePage.title.toLowerCase()}`
                  : "Enter event JSON"
              }
              spellCheck={false}
            />
          </PromptInputBody>
          <PromptInputFooter className="items-center justify-between gap-2 border-t p-2.5">
            <PromptInputTools className="min-w-0 flex-1">
              <PromptInputSelect
                value={selectedTemplateType}
                onValueChange={(value) => {
                  setSelectedTemplateType(value as EventType);
                }}
              >
                <PromptInputSelectTrigger className="h-8 max-w-full min-w-0 text-xs sm:max-w-[18rem]">
                  <span className="truncate">{selectedTemplatePage?.title ?? "Event type"}</span>
                </PromptInputSelectTrigger>
                <PromptInputSelectContent align="start">
                  {eventTypePages.map((page) => (
                    <PromptInputSelectItem key={page.type} value={page.type}>
                      {page.title}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            </PromptInputTools>
            <PromptInputSubmit
              className="shrink-0"
              disabled={appendEvent.isPending || !appendInputJson.trim()}
              status={appendEvent.isPending ? "submitted" : "ready"}
            />
          </PromptInputFooter>
        </PromptInput>
      </footer>
    </section>
  );
}

function parseJSONObject(value: string) {
  const parsed = JSON.parse(value) as unknown;

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Value must be a JSON object.");
  }

  return parsed as JSONObject;
}
