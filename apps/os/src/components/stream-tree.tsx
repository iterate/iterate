import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { cn } from "@iterate-com/ui/lib/utils";
import { normalizePath } from "~/domains/durable-object-names.ts";
import { readStreamStateOnce, type StreamTreeSource } from "~/lib/stream-navigation.ts";
import { streamPathAncestors } from "~/lib/stream-links.ts";

/**
 * THE stream explorer — the one tree in the codebase. The ⌘K switcher and the
 * catalogue side panels (/agents, /sandboxes) all render this.
 *
 * Loading model: every RENDERED node eagerly fetches its own state (one-shot
 * subscribe → first push → unsubscribe, cached in react-query), so the whole
 * visible frontier — including collapsed leaves — resolves at once. That's
 * what lets a node's expand caret appear only when we KNOW it has children;
 * until its state lands the row shimmers instead of guessing.
 */
export function StreamTree({
  currentPath,
  onOpenPath,
  rootPath = "/",
  scope,
  source,
}: {
  /** Highlighted node; its ancestors start expanded. */
  currentPath?: string;
  onOpenPath: (streamPath: string) => void;
  /** The stream the tree is rooted at — e.g. `/agents` scopes it to agents. */
  rootPath?: string;
  /** Query-cache scope (project id, or an admin-prefixed id). */
  scope: string;
  source: StreamTreeSource;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set([rootPath, ...(currentPath ? streamPathAncestors(currentPath) : [])]),
  );

  return (
    <StreamTreeNode
      path={rootPath}
      depth={0}
      tree={{
        currentPath,
        expandedPaths,
        scope,
        source,
        onOpen: onOpenPath,
        onToggle: (path) =>
          setExpandedPaths((previous) => {
            const next = new Set(previous);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          }),
      }}
    />
  );
}

type StreamTreeContext = {
  currentPath?: string;
  expandedPaths: ReadonlySet<string>;
  scope: string;
  source: StreamTreeSource;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
};

/**
 * One tree node and (when expanded) its recursive children. Rendering IS the
 * fetch trigger: the node loads its own state immediately, which supplies the
 * event-count badge, decides whether it earns an expand caret, and (when
 * expanded) the child paths to recurse into.
 */
function StreamTreeNode({
  path,
  depth,
  tree,
}: {
  path: string;
  depth: number;
  tree: StreamTreeContext;
}) {
  const expanded = tree.expandedPaths.has(path);
  const { data, isPending } = useQuery({
    queryKey: ["stream-tree", tree.scope, path],
    queryFn: async () => {
      const streamState = await readStreamStateOnce(tree.source, normalizePath(path));
      return { eventCount: streamState.eventCount, childPaths: streamState.childPaths.toSorted() };
    },
  });
  const childPaths = data?.childPaths ?? [];
  const selected = tree.currentPath === path;

  return (
    <>
      <div
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5",
          selected ? "bg-accent" : "hover:bg-accent/70",
          // Children unknown yet: shimmer the row instead of guessing a caret.
          isPending && "animate-pulse",
        )}
      >
        <span style={{ width: depth * 14 }} className="shrink-0" />
        {childPaths.length > 0 ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${path}` : `Expand ${path}`}
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
          <EventsStreamPathLabel
            path={path}
            label={path === "/" ? "/" : (path.split("/").at(-1) ?? path)}
            className="min-w-0"
          />
          {data == null ? null : (
            <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {data.eventCount}
            </span>
          )}
        </button>
      </div>
      {expanded
        ? childPaths.map((childPath) => (
            <StreamTreeNode key={childPath} path={childPath} depth={depth + 1} tree={tree} />
          ))
        : null}
    </>
  );
}
