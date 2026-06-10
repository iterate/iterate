import { useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import {
  StreamPath,
  type StreamState,
  type StreamPath as StreamPathType,
} from "@iterate-com/shared/streams/types";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { cn } from "@iterate-com/ui/lib/utils";

export type StreamTreeBrowserSource = {
  getState: (streamPath: StreamPathType) => Promise<StreamState>;
  key: QueryKey;
};

export function StreamTreeBrowser({
  currentPath,
  onOpenPath,
  source,
}: {
  currentPath?: StreamPathType;
  onOpenPath: (streamPath: StreamPathType) => void;
  source: StreamTreeBrowserSource;
}) {
  const queryClient = useQueryClient();
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<StreamPathType>>(
    () => new Set<StreamPathType>(["/"]),
  );
  const rootStateQuery = useStreamStateQuery({ source, streamPath: StreamPath.parse("/") });

  function toggleExpanded(path: StreamPathType) {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function refreshPath(path: StreamPathType) {
    await queryClient.invalidateQueries({ queryKey: streamStateQueryKey(source.key, path) });
  }

  if (rootStateQuery.isPending) {
    return <div className="p-4 text-sm text-muted-foreground">Loading stream tree...</div>;
  }

  if (rootStateQuery.isError) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Could not load stream tree</EmptyTitle>
          <EmptyDescription>
            {rootStateQuery.error instanceof Error
              ? rootStateQuery.error.message
              : "The root stream state could not be read."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Streams</h2>
          <p className="text-xs text-muted-foreground">Runtime child paths</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh root stream"
          onClick={() => void refreshPath(StreamPath.parse("/"))}
        >
          <RefreshCwIcon aria-hidden="true" data-icon="icon" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        <StreamTreeNode
          currentPath={currentPath}
          depth={0}
          expandedPaths={expandedPaths}
          onOpenPath={onOpenPath}
          onRefreshPath={refreshPath}
          onToggleExpanded={toggleExpanded}
          source={source}
          state={rootStateQuery.data}
          streamPath={StreamPath.parse("/")}
        />
      </div>
    </div>
  );
}

function StreamTreeNode({
  currentPath,
  depth,
  expandedPaths,
  onOpenPath,
  onRefreshPath,
  onToggleExpanded,
  source,
  state,
  streamPath,
}: {
  currentPath?: StreamPathType;
  depth: number;
  expandedPaths: ReadonlySet<StreamPathType>;
  onOpenPath: (streamPath: StreamPathType) => void;
  onRefreshPath: (streamPath: StreamPathType) => Promise<void>;
  onToggleExpanded: (streamPath: StreamPathType) => void;
  source: StreamTreeBrowserSource;
  state: StreamState;
  streamPath: StreamPathType;
}) {
  const childPaths = useMemo(
    () => [...state.childPaths].sort((left, right) => left.localeCompare(right)),
    [state.childPaths],
  );
  const expanded = expandedPaths.has(streamPath);
  const selected = currentPath === streamPath;

  return (
    <div>
      <div
        className={cn(
          "group flex h-8 min-w-0 items-center gap-1 rounded-md pr-1 text-sm",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
        )}
        style={{ paddingLeft: depth * 14 + 4 }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={expanded ? `Collapse ${streamPath}` : `Expand ${streamPath}`}
          disabled={childPaths.length === 0}
          onClick={() => onToggleExpanded(streamPath)}
        >
          {childPaths.length === 0 ? (
            <span className="size-4" aria-hidden="true" />
          ) : expanded ? (
            <ChevronDownIcon aria-hidden="true" data-icon="icon" />
          ) : (
            <ChevronRightIcon aria-hidden="true" data-icon="icon" />
          )}
        </Button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onOpenPath(streamPath)}
        >
          <EventsStreamPathLabel
            path={streamPath}
            label={streamPathSegment(streamPath)}
            className="min-w-0"
          />
          <Badge variant="secondary" className="ml-auto shrink-0 font-mono text-[10px]">
            {state.eventCount}
          </Badge>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={`Refresh ${streamPath}`}
          onClick={() => void onRefreshPath(streamPath)}
        >
          <RefreshCwIcon aria-hidden="true" data-icon="icon" />
        </Button>
      </div>
      {expanded ? (
        <div>
          {childPaths.map((childPath) => (
            <StreamTreeChild
              key={childPath}
              currentPath={currentPath}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              onOpenPath={onOpenPath}
              onRefreshPath={onRefreshPath}
              onToggleExpanded={onToggleExpanded}
              source={source}
              streamPath={childPath}
            />
          ))}
          {childPaths.length === 0 && depth === 0 ? (
            <p className="px-9 py-2 text-xs text-muted-foreground">No child streams yet.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StreamTreeChild(props: {
  currentPath?: StreamPathType;
  depth: number;
  expandedPaths: ReadonlySet<StreamPathType>;
  onOpenPath: (streamPath: StreamPathType) => void;
  onRefreshPath: (streamPath: StreamPathType) => Promise<void>;
  onToggleExpanded: (streamPath: StreamPathType) => void;
  source: StreamTreeBrowserSource;
  streamPath: StreamPathType;
}) {
  const shouldLoad =
    props.expandedPaths.has(props.streamPath) || props.currentPath === props.streamPath;
  const stateQuery = useStreamStateQuery({
    enabled: shouldLoad,
    source: props.source,
    streamPath: props.streamPath,
  });

  if (stateQuery.isError) {
    return (
      <div
        className="flex h-8 min-w-0 items-center gap-2 rounded-md pr-2 text-sm text-destructive"
        style={{ paddingLeft: props.depth * 14 + 32 }}
      >
        <span className="truncate font-mono">{props.streamPath}</span>
      </div>
    );
  }

  if (stateQuery.data == null) {
    const selected = props.currentPath === props.streamPath;
    return (
      <div
        className={cn(
          "flex h-8 min-w-0 items-center gap-1 rounded-md pr-1 text-sm",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
        )}
        style={{ paddingLeft: props.depth * 14 + 4 }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={`Load ${props.streamPath}`}
          onClick={() => props.onToggleExpanded(props.streamPath)}
        >
          <ChevronRightIcon aria-hidden="true" data-icon="icon" />
        </Button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => props.onOpenPath(props.streamPath)}
        >
          <EventsStreamPathLabel
            path={props.streamPath}
            label={streamPathSegment(props.streamPath)}
            className="min-w-0"
          />
        </button>
      </div>
    );
  }

  return <StreamTreeNode {...props} state={stateQuery.data} />;
}

function useStreamStateQuery(input: {
  enabled?: boolean;
  source: StreamTreeBrowserSource;
  streamPath: StreamPathType;
}) {
  return useQuery({
    enabled: input.enabled ?? true,
    queryKey: streamStateQueryKey(input.source.key, input.streamPath),
    queryFn: () => input.source.getState(input.streamPath),
    staleTime: 10_000,
  });
}

function streamStateQueryKey(sourceKey: QueryKey, streamPath: StreamPathType) {
  return [...sourceKey, "state", streamPath] as const;
}

function streamPathSegment(path: StreamPathType) {
  return path === "/" ? "/" : (path.split("/").at(-1) ?? path);
}
