import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { StreamPath, type Event } from "@iterate-com/events-contract";
import { Button } from "@iterate-com/ui/components/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { toast } from "@iterate-com/ui/components/sonner";
import { Plus } from "lucide-react";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";
import { ROOT_STREAM_PATH } from "~/lib/utils.ts";
import { orpc, orpcClient } from "~/orpc/client.ts";
import { useStreamsChrome } from "~/components/streams-chrome.tsx";

const DEFAULT_NEW_STREAM_PATH = "/some-stream";

export function StreamsSidebar() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectedStreamPath } = useStreamsChrome();
  const [searchValue, setSearchValue] = useState("");
  const [isCreatingStream, setIsCreatingStream] = useState(false);
  const [newStreamPathInput, setNewStreamPathInput] = useState("");
  const search = useSearch({ strict: false });
  const currentRenderer =
    "renderer" in search && typeof search.renderer === "string"
      ? search.renderer
      : defaultStreamViewSearch.renderer;

  const streamsQuery = useQuery({
    ...orpc.listStreams.queryOptions({ input: {} }),
    staleTime: 30_000,
  });

  const rootStateQuery = useQuery({
    ...orpc.getState.queryOptions({ input: { path: ROOT_STREAM_PATH } }),
    staleTime: 30_000,
  });
  const rootLastOffset =
    typeof rootStateQuery.data?.lastOffset === "string"
      ? rootStateQuery.data.lastOffset
      : undefined;

  useEffect(() => {
    if (
      selectedStreamPath === ROOT_STREAM_PATH ||
      rootStateQuery.isPending ||
      rootStateQuery.isError
    ) {
      return;
    }

    const controller = new AbortController();
    let isCurrent = true;
    let iterator: AsyncIterator<Event> | undefined;

    void (async () => {
      const stream = await orpcClient.stream(
        {
          path: ROOT_STREAM_PATH,
          offset: rootLastOffset,
          live: true,
        },
        { signal: controller.signal },
      );

      iterator = stream[Symbol.asyncIterator]();

      if (!isCurrent || controller.signal.aborted) {
        return;
      }

      for await (const event of stream) {
        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        if (event.type !== "https://events.iterate.com/events/stream/initialized") {
          continue;
        }

        void queryClient.invalidateQueries({ queryKey: orpc.listStreams.key() });
      }
    })().catch((error) => {
      if (!isCurrent || controller.signal.aborted) {
        return;
      }

      toast.error(readErrorMessage(error));
    });

    return () => {
      isCurrent = false;
      controller.abort();
      void iterator?.return?.();
    };
  }, [
    queryClient,
    rootStateQuery.isError,
    rootStateQuery.isPending,
    rootLastOffset,
    selectedStreamPath,
  ]);

  const filteredStreams = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    const streams = streamsQuery.data ?? [];

    if (query.length === 0) {
      return streams;
    }

    return streams.filter((stream) => stream.path.toLowerCase().includes(query));
  }, [streamsQuery.data, searchValue]);

  const isLoadingStreams = streamsQuery.isPending && streamsQuery.data == null;

  function openCreateStreamForm() {
    setNewStreamPathInput(DEFAULT_NEW_STREAM_PATH);
    setIsCreatingStream(true);
  }

  function cancelCreateStream() {
    setIsCreatingStream(false);
    setNewStreamPathInput("");
  }

  function submitNewStreamPath() {
    const trimmed = newStreamPathInput.trim();
    if (trimmed.length === 0) {
      toast.error("Enter a stream path");
      return;
    }

    const parsed = StreamPath.safeParse(trimmed);
    if (!parsed.success) {
      toast.error(
        "Use lowercase letters, numbers, hyphens, underscores, and slashes only (e.g. my-stream or team/inbox).",
      );
      return;
    }

    if (parsed.data === ROOT_STREAM_PATH) {
      toast.error("Pick a path under a non-root stream.");
      return;
    }

    void navigate({
      to: "/streams/$/",
      params: { _splat: streamPathToSplat(parsed.data) },
      search: { event: defaultStreamViewSearch.event, renderer: currentRenderer },
    });
    cancelCreateStream();
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Streams</SidebarGroupLabel>
      <SidebarGroupContent className="space-y-2">
        {!isLoadingStreams ? (
          <>
            <SidebarInput
              value={searchValue}
              onChange={(event) => setSearchValue(event.currentTarget.value)}
              placeholder="Filter streams"
            />

            <SidebarMenu>
              {filteredStreams.map((stream) => (
                <SidebarMenuItem key={stream.path}>
                  <SidebarMenuButton
                    render={
                      stream.path === ROOT_STREAM_PATH ? (
                        <Link
                          to="/streams/"
                          search={{
                            event: defaultStreamViewSearch.event,
                            renderer: currentRenderer,
                          }}
                          activeOptions={{ exact: true }}
                        />
                      ) : (
                        <Link
                          to="/streams/$/"
                          params={{ _splat: streamPathToSplat(stream.path) }}
                          search={{
                            event: defaultStreamViewSearch.event,
                            renderer: currentRenderer,
                          }}
                        />
                      )
                    }
                    isActive={selectedStreamPath === stream.path}
                    className="h-auto py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs">{stream.path}</div>
                      <div className="text-[11px] text-muted-foreground">{stream.createdAt}</div>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </>
        ) : null}

        {isCreatingStream ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitNewStreamPath();
            }}
          >
            <SidebarInput
              value={newStreamPathInput}
              onChange={(event) => setNewStreamPathInput(event.currentTarget.value)}
              onFocus={(event) => {
                if (event.currentTarget.value === DEFAULT_NEW_STREAM_PATH) {
                  event.currentTarget.select();
                }
              }}
              placeholder="e.g. my-stream or team/inbox"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  cancelCreateStream();
                }
              }}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={cancelCreateStream}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" className="flex-1">
                Open
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="h-9 w-full justify-start gap-2 px-2.5 font-normal"
            onClick={openCreateStreamForm}
          >
            <Plus className="size-4 shrink-0" />
            Create stream
          </Button>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
