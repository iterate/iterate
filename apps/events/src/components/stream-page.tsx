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
import { Label } from "@iterate-com/ui/components/label";
import { Separator } from "@iterate-com/ui/components/separator";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { stringify as stringifyYaml } from "yaml";
import { StreamEventFeed } from "~/components/stream-event-feed.tsx";
import { useLiveStreamEvents } from "~/hooks/use-live-stream-events.ts";
import { eventInputTemplates, getEventInputTemplateById } from "~/lib/event-type-pages.ts";
import { parseObjectFromComposerText } from "~/lib/stream-composer-input.ts";
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

  const { events, isConnecting } = useLiveStreamEvents({
    streamPath,
    onEvent: useCallback(
      (event: Event) => {
        if (
          streamPath === "/" &&
          event.type === "https://events.iterate.com/events/stream/child-stream-created"
        ) {
          void queryClient.invalidateQueries({ queryKey: listChildrenOptions.queryKey });
        }
      },
      [listChildrenOptions.queryKey, queryClient, streamPath],
    ),
  });
  const feed = useMemo(() => projectWireToFeed(events), [events]);
  const displayFeed = useMemo(() => buildDisplayFeed(feed, rendererMode), [feed, rendererMode]);
  const feedSummary = useMemo(() => summarizeStreamFeed(feed), [feed]);

  useEffect(() => {
    setAppendInputJson(createEventInputTemplate(selectedTemplateId, "json"));
    setAppendInputYaml(createEventInputTemplate(selectedTemplateId, "yaml"));
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
        void queryClient.invalidateQueries({ queryKey: listChildrenOptions.queryKey });
        await queryClient.invalidateQueries({ queryKey: streamStateOptions.queryKey });
      },
    }),
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
        type: "agent-input-added",
        payload: {
          role: "user",
          content,
        },
      },
    });
    setAgentInputText("");
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
        <PromptInput className="relative w-full" onSubmit={handleComposerSubmit}>
          <PromptInputBody>
            {composerMode === "agent" ? (
              <PromptInputTextarea
                value={agentInputText}
                onChange={(event) => setAgentInputText(event.currentTarget.value)}
                placeholder="Message this agent"
                className="min-h-11 max-h-[45vh] text-sm leading-5"
              />
            ) : composerMode === "yaml" ? (
              <SourceCodeBlock
                code={appendInputYaml}
                language="yaml"
                editable
                onChange={setAppendInputYaml}
                onModEnter={handleComposerSubmit}
                showCopyButton={false}
                className="w-full max-h-[45vh]"
              />
            ) : (
              <SourceCodeBlock
                code={appendInputJson}
                language="json"
                editable
                onChange={setAppendInputJson}
                onModEnter={handleComposerSubmit}
                showCopyButton={false}
                className="w-full max-h-[45vh]"
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
                    <TabsTrigger value="json" className="px-2 text-xs">
                      JSON
                    </TabsTrigger>
                    <TabsTrigger value="yaml" className="px-2 text-xs">
                      YAML
                    </TabsTrigger>
                    <TabsTrigger value="agent" className="px-2 text-xs">
                      Agent
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                {composerMode !== "agent" ? (
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
                    <PromptInputSelectContent align="start" className="w-fit">
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
                (composerMode === "agent"
                  ? !agentInputText.trim()
                  : composerMode === "yaml"
                    ? !appendInputYaml.trim()
                    : !appendInputJson.trim())
              }
              status={appendEvent.isPending ? "submitted" : "ready"}
            />
          </PromptInputFooter>
        </PromptInput>
      </footer>
    </section>
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
