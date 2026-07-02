import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  parseBrowserCoreStreamTreeState,
  type BrowserCoreStreamTreeState,
} from "~/domains/streams/client-libraries/browser/core-processor-state.ts";

/**
 * Where tree nodes get their state: path → stream handle. Project pages pass
 * `(path) => itx.streams.get(path)`, the admin explorer
 * `(path) => itx.projects.get(projectId).streams.get(path)`. Each loaded node
 * holds one live subscription (the first push carries current state, later
 * pushes follow every append), so the tree is LIVE — no query cache, plain
 * component state. The batch's `state` is the server core reduced state, typed
 * `unknown` on the wire and parsed here.
 */
type StreamSubscription = { unsubscribe(): unknown };

export type StreamTreeSource = (streamPath: string) => {
  subscribe(args: {
    events?: boolean;
    processEventBatch(batch: { state: unknown }): unknown;
  }): Promise<StreamSubscription>;
};

/** Tear down one live stream subscription (best-effort unsubscribe + dispose). */
function disposeStreamSubscription(subscription: StreamSubscription): void {
  void Promise.resolve(subscription.unsubscribe()).catch(() => {});
  (subscription as Partial<Disposable>)[Symbol.dispose]?.();
}

type NodeState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "live"; state: BrowserCoreStreamTreeState };

/**
 * Live state of one stream path. The subscription's initial push paints the
 * node; refresh() tears down and re-subscribes (a fresh initial push) — the
 * manual recovery path if a Stream DO was evicted under a silent stream.
 */
function useLiveStreamState(input: {
  enabled: boolean;
  source: StreamTreeSource;
  streamPath: string;
}): { node: NodeState; refresh: () => void } {
  const { enabled, source, streamPath } = input;
  const [node, setNode] = useState<NodeState>({ status: "loading" });
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    // Back to "loading" on every (re)subscribe — refresh() exists to recover
    // from a silently stalled subscription, so it must not keep painting the
    // stale live state while the new subscription connects.
    setNode({ status: "loading" });
    if (!enabled) return;
    let disposed = false;
    let release: (() => void) | null = null;
    source(streamPath)
      .subscribe({
        events: false,
        processEventBatch: (batch) => {
          if (disposed) return;
          setNode({
            status: "live",
            state: parseBrowserCoreStreamTreeState(batch.state),
          });
        },
      })
      .then((subscription) => {
        if (disposed) disposeStreamSubscription(subscription);
        else release = () => disposeStreamSubscription(subscription);
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
  rootPath = "/",
  source,
}: {
  currentPath?: string;
  onOpenPath: (streamPath: string) => void;
  /** The stream the tree is rooted at — defaults to the project root. Pass a
   * subtree (e.g. `/agents`) to scope the browser to it. */
  rootPath?: string;
  source: StreamTreeSource;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>([rootPath]),
  );
  const root = useLiveStreamState({ enabled: true, source, streamPath: rootPath });

  function toggleExpanded(path: string) {
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
          streamPath={rootPath}
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
  currentPath?: string;
  depth: number;
  expandedPaths: ReadonlySet<string>;
  onOpenPath: (streamPath: string) => void;
  /** Re-subscribes THIS node's live state. */
  onRefresh: () => void;
  onToggleExpanded: (streamPath: string) => void;
  source: StreamTreeSource;
  state: BrowserCoreStreamTreeState;
  streamPath: string;
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
  currentPath?: string;
  depth: number;
  expandedPaths: ReadonlySet<string>;
  onOpenPath: (streamPath: string) => void;
  onToggleExpanded: (streamPath: string) => void;
  source: StreamTreeSource;
  streamPath: string;
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

function streamPathSegment(path: string) {
  return path === "/" ? "/" : (path.split("/").at(-1) ?? path);
}
