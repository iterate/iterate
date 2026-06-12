import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, CirclePlusIcon } from "lucide-react";
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@iterate-com/ui/components/command";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  parentStreamPath,
  readStreamStateOnce,
  type StreamNavigator,
} from "~/lib/stream-navigation.ts";
import { streamPathAncestors } from "~/lib/stream-links.ts";

// One path segment of the canonical StreamPath pattern (shared streams types).
const STREAM_SEGMENT_PATTERN = /^[a-z0-9_-]+$/;

/**
 * The streams command palette: a lazily-loaded tree rooted at "/", flattened
 * into indented cmdk rows so typing filters across all loaded nodes.
 * Enter opens the highlighted stream; →/← expand/collapse it in place.
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
  const [query, setQuery] = useState("");
  const [selectedValue, setSelectedValue] = useState("");

  // Opening reveals "where you are": every ancestor (and the current stream
  // itself) starts expanded, with the current stream highlighted.
  useEffect(() => {
    if (!open) return;
    setExpandedPaths(new Set(["/", ...streamPathAncestors(currentPath)]));
    setQuery("");
    setSelectedValue(currentPath);
  }, [open, currentPath]);

  function openStream(path: string) {
    onOpenChange(false);
    navigator.onOpenPath(StreamPath.parse(path));
  }

  function setExpanded(path: string, value: boolean) {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (value) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  const newChildPath = STREAM_SEGMENT_PATTERN.test(query)
    ? `${currentPath === "/" ? "" : currentPath}/${query}`
    : null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Switch stream"
      description="Browse and open streams"
      className="sm:max-w-lg"
    >
      <Command
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDown={(event) => {
          // →/← expand/collapse the highlighted node; ← on a collapsed node
          // jumps to its parent. Only while not filtering (the tree rows hide
          // under a filter, and ←/→ should move the input caret then).
          if (query !== "" || !selectedValue.startsWith("/")) return;
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setExpanded(selectedValue, true);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (expandedPaths.has(selectedValue)) setExpanded(selectedValue, false);
            else setSelectedValue(parentStreamPath(selectedValue));
          }
        }}
      >
        <CommandInput placeholder="Go to stream…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>No streams found.</CommandEmpty>
          <CommandGroup heading="Streams">
            <StreamTreeItem
              path="/"
              depth={0}
              tree={{ currentPath, expandedPaths, navigator, scope, onOpen: openStream }}
            />
          </CommandGroup>
          <CommandGroup heading="New">
            {/* forceMount: the typed name is a new stream, so it never matches
                the filter. Streams are lazily created — navigating IS creating. */}
            <CommandItem
              forceMount
              value="create-child-stream"
              disabled={newChildPath == null}
              onSelect={() => newChildPath != null && openStream(newChildPath)}
            >
              <CirclePlusIcon className="size-3.5 text-muted-foreground" />
              <span className="truncate font-mono text-xs">
                {newChildPath == null
                  ? `Type a name (a-z, 0-9, -, _) to create a child of ${currentPath}`
                  : `Create ${newChildPath}`}
              </span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>→ expand</span>
          <span>← collapse</span>
          <span>esc close</span>
        </div>
      </Command>
    </CommandDialog>
  );
}

type StreamTreeContext = {
  currentPath: string;
  expandedPaths: ReadonlySet<string>;
  navigator: StreamNavigator;
  scope: string;
  onOpen: (path: string) => void;
};

/**
 * One tree node and (when expanded) its recursive children. Each node loads
 * its own state once — that single read supplies both the event count badge
 * and the child paths to recurse into. Fragments keep every CommandItem a
 * direct DOM child of the group, so cmdk's filtering sees a flat list.
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
      <CommandItem
        value={path}
        onSelect={() => tree.onOpen(path)}
        className={cn(path === tree.currentPath && "bg-accent/50")}
      >
        <span style={{ width: depth * 14 }} className="shrink-0" />
        {childPaths.length > 0 ? (
          expanded ? (
            <ChevronDownIcon className="size-3.5 text-muted-foreground/60" />
          ) : (
            <ChevronRightIcon className="size-3.5 text-muted-foreground/60" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="truncate font-mono text-xs">
          {path === "/" ? "/" : (path.split("/").at(-1) ?? path)}
        </span>
        {state.data == null ? null : (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {state.data.eventCount}
          </span>
        )}
      </CommandItem>
      {expanded
        ? childPaths.map((childPath) => (
            <StreamTreeItem key={childPath} path={childPath} depth={depth + 1} tree={tree} />
          ))
        : null}
    </>
  );
}
