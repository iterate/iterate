import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import {
  StreamPath,
  StreamState,
  type StreamPath as StreamPathType,
  type StreamState as StreamStateType,
} from "@iterate-com/shared/streams/types";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { cn } from "@iterate-com/ui/lib/utils";

/**
 * Where tree nodes get their state: path → stream handle. Project pages pass
 * `(path) => itx.streams.get(path)`, the admin explorer
 * `(path) => itx.streams.namespace(ns).get(path)`. Each loaded node holds one
 * live `onStateChange` subscription (DECISIONS D20: the first push carries
 * current state, later pushes follow every append), so the tree is LIVE — no
 * query cache, plain component state.
 */
export type StreamTreeSource = (streamPath: StreamPathType) => {
  onStateChange(onState: (state: StreamStateType) => void): Promise<{ unsubscribe(): unknown }>;
};

type NodeState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "live"; state: StreamStateType };

/**
 * Live state of one stream path. The subscription's initial push paints the
 * node; refresh() tears down and re-subscribes (a fresh initial push) — the
 * manual recovery path if a Stream DO was evicted under a silent stream.
 */
function useLiveStreamState(input: {
  enabled: boolean;
  source: StreamTreeSource;
  streamPath: StreamPathType;
}): { node: NodeState; refresh: () => void } {
  const { enabled, source, streamPath } = input;
  const [node, setNode] = useState<NodeState>({ status: "loading" });
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let release: (() => void) | null = null;
    source(streamPath)
      .onStateChange((next) => {
        if (disposed) return;
        setNode({ status: "live", state: StreamState.parse(next) });
      })
      .then((subscription) => {
        // The far end may already be gone when we unsubscribe — never let
        // that reject unhandled.
        const releaseSubscription = () =>
          void Promise.resolve(subscription.unsubscribe()).catch(() => {});
        if (disposed) releaseSubscription();
        else release = releaseSubscription;
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setNode({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
      release?.();
    };
  }, [enabled, source, streamPath, epoch]);

  return { node, refresh: () => setEpoch((current) => current + 1) };
}

export function StreamTreeBrowser({
  currentPath,
  onOpenPath,
  source,
}: {
  currentPath?: StreamPathType;
  onOpenPath: (streamPath: StreamPathType) => void;
  source: StreamTreeSource;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<StreamPathType>>(
    () => new Set<StreamPathType>(["/"]),
  );
  const root = useLiveStreamState({ enabled: true, source, streamPath: StreamPath.parse("/") });

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

  if (root.node.status === "loading") {
    return <div className="p-4 text-sm text-muted-foreground">Loading stream tree...</div>;
  }

  if (root.node.status === "error") {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Could not load stream tree</EmptyTitle>
          <EmptyDescription>{root.node.message}</EmptyDescription>
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
          onClick={root.refresh}
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
          onRefresh={root.refresh}
          onToggleExpanded={toggleExpanded}
          source={source}
          state={root.node.state}
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
  onRefresh,
  onToggleExpanded,
  source,
  state,
  streamPath,
}: {
  currentPath?: StreamPathType;
  depth: number;
  expandedPaths: ReadonlySet<StreamPathType>;
  onOpenPath: (streamPath: StreamPathType) => void;
  /** Re-subscribes THIS node's live state. */
  onRefresh: () => void;
  onToggleExpanded: (streamPath: StreamPathType) => void;
  source: StreamTreeSource;
  state: StreamStateType;
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
          onClick={onRefresh}
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
  onToggleExpanded: (streamPath: StreamPathType) => void;
  source: StreamTreeSource;
  streamPath: StreamPathType;
}) {
  const shouldLoad =
    props.expandedPaths.has(props.streamPath) || props.currentPath === props.streamPath;
  const { node, refresh } = useLiveStreamState({
    enabled: shouldLoad,
    source: props.source,
    streamPath: props.streamPath,
  });

  if (node.status === "error") {
    return (
      <div
        className="flex h-8 min-w-0 items-center gap-2 rounded-md pr-2 text-sm text-destructive"
        style={{ paddingLeft: props.depth * 14 + 32 }}
      >
        <span className="truncate font-mono">{props.streamPath}</span>
      </div>
    );
  }

  if (node.status === "loading") {
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

  return <StreamTreeNode {...props} onRefresh={refresh} state={node.state} />;
}

function streamPathSegment(path: StreamPathType) {
  return path === "/" ? "/" : (path.split("/").at(-1) ?? path);
}
