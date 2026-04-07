import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Event,
  type EventInput,
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
import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import { Input } from "@iterate-com/ui/components/input";
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
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { StreamEventFeed } from "~/components/stream-event-feed.tsx";
import { useCurrentProjectSlug } from "~/hooks/use-current-project-slug.ts";
import { useLiveStreamEvents } from "~/hooks/use-live-stream-events.ts";
import { eventInputTemplates, getEventInputTemplateById } from "~/lib/event-type-pages.ts";
import { projectScopedQueryKey } from "~/lib/project-slug.ts";
import { buildDisplayFeed, projectWireToFeed } from "~/lib/stream-feed-projection.ts";
import { summarizeStreamFeed } from "~/lib/stream-feed-summary.ts";
import { DEFAULT_STREAM_RENDERER_MODE, type StreamRendererMode } from "~/lib/stream-feed-types.ts";
import { formatClientError } from "~/lib/format-client-error.ts";
import { defaultStreamViewSearch, type StreamComposerMode } from "~/lib/stream-view-search.ts";
import { getOrpc } from "~/orpc/client.ts";
import { useStreamsChrome } from "~/components/streams-chrome.tsx";

const DEFAULT_EVENT_TEMPLATE_ID = "manual-event-appended:default";

export function StreamPage({
  streamPath,
  rendererMode = DEFAULT_STREAM_RENDERER_MODE,
  composerMode = defaultStreamViewSearch.composer,
  openEventOffset,
  onOpenEventOffsetChange,
  onRendererModeChange,
  onComposerModeChange,
}: {
  streamPath: StreamPath;
  rendererMode?: StreamRendererMode;
  composerMode?: StreamComposerMode;
  openEventOffset?: number;
  onOpenEventOffsetChange?: (offset?: number) => void;
  onRendererModeChange?: (mode: StreamRendererMode) => void;
  onComposerModeChange?: (mode: StreamComposerMode) => void;
}) {
  const queryClient = useQueryClient();
  const { closeMetadata, metadataOpen, setHeaderControls } = useStreamsChrome();
  const orpc = getOrpc();
  const projectSlug = useCurrentProjectSlug();
  const [selectedTemplateId, setSelectedTemplateId] = useState(DEFAULT_EVENT_TEMPLATE_ID);
  const [appendInputJson, setAppendInputJson] = useState(() =>
    createEventInputTemplate(DEFAULT_EVENT_TEMPLATE_ID),
  );
  const [agentInputText, setAgentInputText] = useState("");
  const streamStateOptions = useMemo(
    () => orpc.getState.queryOptions({ input: { path: streamPath } }),
    [streamPath],
  );
  const streamStateQueryKey = useMemo(
    () => projectScopedQueryKey(streamStateOptions.queryKey, projectSlug),
    [projectSlug, streamStateOptions.queryKey],
  );
  const listChildrenOptions = useMemo(
    () => orpc.listChildren.queryOptions({ input: { path: "/" } }),
    [],
  );
  const listChildrenQueryKey = useMemo(
    () => projectScopedQueryKey(listChildrenOptions.queryKey, projectSlug),
    [listChildrenOptions.queryKey, projectSlug],
  );

  const streamStateQuery = useQuery({
    ...streamStateOptions,
    queryKey: streamStateQueryKey,
    staleTime: 5_000,
  });

  const { events, isConnecting } = useLiveStreamEvents({
    streamPath,
    projectSlug,
    onEvent: useCallback(
      (event: Event) => {
        if (
          streamPath === "/" &&
          event.type === "https://events.iterate.com/events/stream/child-stream-created"
        ) {
          void queryClient.invalidateQueries({ queryKey: listChildrenQueryKey });
        }
      },
      [listChildrenQueryKey, queryClient, streamPath],
    ),
  });
  const feed = useMemo(() => projectWireToFeed(events), [events]);
  const displayFeed = useMemo(() => buildDisplayFeed(feed, rendererMode), [feed, rendererMode]);
  const feedSummary = useMemo(() => summarizeStreamFeed(feed), [feed]);

  useEffect(() => {
    setAppendInputJson(createEventInputTemplate(selectedTemplateId));
  }, [selectedTemplateId]);

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

  const [destroyChildren, setDestroyChildren] = useState(true);

  const appendEvent = useMutation(
    orpc.append.mutationOptions({
      onSuccess: async () => {
        void queryClient.invalidateQueries({ queryKey: listChildrenQueryKey });
        await queryClient.invalidateQueries({ queryKey: streamStateQueryKey });
      },
    }),
  );

  const destroyStream = useMutation(
    orpc.destroy.mutationOptions({
      onSuccess: async () => {
        closeMetadata();
        void queryClient.invalidateQueries({ queryKey: listChildrenQueryKey });
        await queryClient.invalidateQueries({ queryKey: streamStateQueryKey });
      },
    }),
  );
  const submitAppendEvent = async ({ event }: { event: EventInput }) => {
    const request = appendEvent.mutateAsync({
      path: streamPath,
      event,
    });

    void toast.promise(request, {
      loading: "Appending event",
      success: "Event appended",
      error: (error) => formatClientError(error),
    });

    await request.catch(() => undefined);
  };

  const submitRawAppend = async ({ inputText }: { inputText: string }) => {
    let event: EventInput;

    try {
      event = parseAppendEventInput(inputText);
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
        type: "llm-input-added",
        payload: {
          content,
          source: "user",
        },
      },
    });
    setAgentInputText("");
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

            <Separator className="my-6" />

            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Permanently destroy this stream. This cannot be undone.
              </p>

              <div className="mt-4 flex items-center gap-2">
                <Checkbox
                  id="destroy-children"
                  checked={destroyChildren}
                  onCheckedChange={(checked) => setDestroyChildren(checked)}
                />
                <Label htmlFor="destroy-children" className="text-xs">
                  Destroy child streams
                </Label>
              </div>

              <Button
                variant="destructive"
                size="sm"
                className="mt-4"
                disabled={destroyStream.isPending}
                onClick={() => {
                  const request = destroyStream.mutateAsync({
                    params: { path: streamPath },
                    query: { destroyChildren },
                  });
                  void toast.promise(request, {
                    loading: "Destroying stream…",
                    success: (result) =>
                      `Destroyed ${result.destroyedStreamCount} stream${result.destroyedStreamCount === 1 ? "" : "s"}`,
                    error: (error) => formatClientError(error),
                  });
                }}
              >
                {destroyStream.isPending ? "Destroying…" : "Destroy stream"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <footer className="supports-backdrop-filter:bg-background/80 shrink-0 border-t bg-background/95 px-4 py-4">
        <PromptInput
          className="relative w-full"
          onSubmit={async () => {
            if (composerMode === "agent") {
              await submitAgentAppend({ inputText: agentInputText });
              return;
            }

            await submitRawAppend({ inputText: appendInputJson });
          }}
        >
          <PromptInputBody>
            {composerMode === "agent" ? (
              <Input
                autoFocus
                data-slot="input-group-control"
                value={agentInputText}
                onChange={(event) => setAgentInputText(event.currentTarget.value)}
                placeholder="Message this agent"
                className="h-11 rounded-none border-0 bg-transparent px-4 shadow-none focus-visible:ring-0"
              />
            ) : (
              <PromptInputTextarea
                value={appendInputJson}
                onChange={(event) => setAppendInputJson(event.currentTarget.value)}
                className="min-h-36 max-h-[45vh] font-mono text-xs leading-5"
                placeholder="Enter event JSON"
                spellCheck={false}
              />
            )}
          </PromptInputBody>
          <PromptInputFooter className="items-center justify-between gap-2 border-t p-2.5">
            <PromptInputTools className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Tabs
                  value={composerMode}
                  onValueChange={(value) => onComposerModeChange?.(value as StreamComposerMode)}
                >
                  <TabsList className="h-8">
                    <TabsTrigger value="raw" className="px-2 text-xs">
                      Raw
                    </TabsTrigger>
                    <TabsTrigger value="agent" className="px-2 text-xs">
                      Agent
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                {composerMode === "raw" ? (
                  <PromptInputSelect
                    value={selectedTemplateId}
                    onValueChange={(value) => {
                      setSelectedTemplateId(value as string);
                    }}
                  >
                    <PromptInputSelectTrigger className="h-8 max-w-full min-w-0 text-xs sm:max-w-[18rem]">
                      <span className="truncate">
                        {getEventInputTemplateById(selectedTemplateId)?.label ?? "Event template"}
                      </span>
                    </PromptInputSelectTrigger>
                    <PromptInputSelectContent align="start">
                      {eventInputTemplates.map((template) => (
                        <PromptInputSelectItem key={template.id} value={template.id}>
                          {template.label}
                        </PromptInputSelectItem>
                      ))}
                    </PromptInputSelectContent>
                  </PromptInputSelect>
                ) : null}
              </div>
            </PromptInputTools>
            <PromptInputSubmit
              className="shrink-0"
              disabled={
                appendEvent.isPending ||
                (composerMode === "agent" ? !agentInputText.trim() : !appendInputJson.trim())
              }
              status={appendEvent.isPending ? "submitted" : "ready"}
            />
          </PromptInputFooter>
        </PromptInput>
      </footer>
    </section>
  );
}

function createEventInputTemplate(templateId: string) {
  const template =
    getEventInputTemplateById(templateId) ?? getEventInputTemplateById(DEFAULT_EVENT_TEMPLATE_ID);

  return JSON.stringify(JSON.parse(JSON.stringify(template?.event ?? {})) as JSONObject, null, 2);
}

function parseJSONObject(value: string) {
  const parsed = JSON.parse(value) as unknown;

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Value must be a JSON object.");
  }

  return parsed as JSONObject;
}

function parseAppendEventInput(value: string) {
  // Only require syntactically valid JSON here. The append endpoint will
  // normalize invalid event shapes into invalid-event-appended server-side.
  return parseJSONObject(value) as EventInput;
}
