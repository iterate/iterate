import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/dialog";
import { Input } from "@iterate-com/ui/components/input";
import { cn } from "@iterate-com/ui/lib/utils";
import { readStreamStateOnce, type StreamNavigator } from "~/lib/stream-navigation.ts";
import { streamPathAncestors } from "~/lib/stream-links.ts";

// One path segment of the canonical StreamPath pattern (shared streams types).
const STREAM_SEGMENT_PATTERN = /^[a-z0-9_-]+$/;

/**
 * The ⌘K stream dialog, deliberately simple: the current stream with a form
 * to create a child under it, and the stream tree (expanded along the current
 * path) to click around. Streams are lazily created — navigating IS creating.
 */
export function StreamSwitcherDialog({
  open,
  onOpenChange,
  currentPath,
  navigator,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: StreamPathType;
  navigator: StreamNavigator;
  scope: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set(["/"]));
  const [childName, setChildName] = useState("");

  // Opening reveals "where you are": every ancestor (and the current stream
  // itself) starts expanded.
  useEffect(() => {
    if (!open) return;
    setExpandedPaths(new Set(["/", ...streamPathAncestors(currentPath)]));
    setChildName("");
  }, [open, currentPath]);

  function openStream(path: string) {
    onOpenChange(false);
    navigator.onOpenPath(StreamPath.parse(path));
  }

  const childNameValid = STREAM_SEGMENT_PATTERN.test(childName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="font-mono text-sm font-medium">{currentPath}</DialogTitle>
          <DialogDescription className="sr-only">
            Create a child stream or open another stream
          </DialogDescription>
          <form
            className="flex items-center gap-2 pt-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!childNameValid) return;
              openStream(`${currentPath === "/" ? "" : currentPath}/${childName}`);
            }}
          >
            <Input
              value={childName}
              onChange={(event) => setChildName(event.target.value)}
              placeholder="new-child-stream"
              aria-label="New child stream name"
              className="h-8 font-mono text-xs"
            />
            <Button type="submit" size="sm" disabled={!childNameValid}>
              Create
            </Button>
          </form>
          {childName !== "" && !childNameValid ? (
            <p className="text-xs text-muted-foreground">
              Names are lowercase letters, digits, - and _.
            </p>
          ) : null}
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto p-2">
          <StreamTreeItem
            path="/"
            depth={0}
            tree={{
              currentPath,
              expandedPaths,
              navigator,
              scope,
              onOpen: openStream,
              onToggle: (path) =>
                setExpandedPaths((previous) => {
                  const next = new Set(previous);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                }),
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

type StreamTreeContext = {
  currentPath: string;
  expandedPaths: ReadonlySet<string>;
  navigator: StreamNavigator;
  scope: string;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
};

/**
 * One tree node and (when expanded) its recursive children. Each node loads
 * its own state once — that single read supplies both the event count badge
 * and the child paths to recurse into.
 */
function StreamTreeItem({
  path,
  depth,
  tree,
}: {
  path: string;
  depth: number;
  tree: StreamTreeContext;
}) {
  const expanded = tree.expandedPaths.has(path);
  const state = useQuery({
    queryKey: ["stream-switcher-children", tree.scope, path],
    queryFn: async () => {
      const streamState = await readStreamStateOnce(tree.navigator.source, StreamPath.parse(path));
      return { eventCount: streamState.eventCount, childPaths: [...streamState.childPaths].sort() };
    },
  });
  const childPaths = state.data?.childPaths ?? [];

  return (
    <>
      <div
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent",
          path === tree.currentPath && "bg-accent/50",
        )}
      >
        <span style={{ width: depth * 14 }} className="shrink-0" />
        {childPaths.length > 0 ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            className="-m-1 shrink-0 rounded p-1 hover:bg-muted"
            onClick={() => tree.onToggle(path)}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5 text-muted-foreground/60" />
            ) : (
              <ChevronRightIcon className="size-3.5 text-muted-foreground/60" />
            )}
          </button>
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => tree.onOpen(path)}
        >
          <span className="truncate font-mono text-xs">
            {path === "/" ? "/" : (path.split("/").at(-1) ?? path)}
          </span>
          {state.data == null ? null : (
            <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {state.data.eventCount}
            </span>
          )}
        </button>
      </div>
      {expanded
        ? childPaths.map((childPath) => (
            <StreamTreeItem key={childPath} path={childPath} depth={depth + 1} tree={tree} />
          ))
        : null}
    </>
  );
}
