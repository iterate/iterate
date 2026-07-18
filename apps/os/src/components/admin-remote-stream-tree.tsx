import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { cn } from "@iterate-com/ui/lib/utils";
import { normalizePath } from "~/domains/durable-object-names.ts";
import { readStreamStateOnce, type StreamTreeSource } from "~/lib/stream-navigation.ts";
import { streamPathAncestors } from "~/lib/stream-links.ts";

/**
 * Lazy tree for the platform-wide admin explorer, whose remote/global streams
 * do not have a project live-state index. Product project surfaces use the
 * materialized `streamsIndex` instead.
 */
export function AdminRemoteStreamTree({
  currentPath,
  onOpenPath,
  scope,
  source,
}: {
  currentPath: string;
  onOpenPath: (streamPath: string) => void;
  scope: string;
  source: StreamTreeSource;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set(["/", ...streamPathAncestors(currentPath)]),
  );

  return (
    <AdminRemoteStreamTreeNode
      path="/"
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

type AdminRemoteTreeContext = {
  currentPath: string;
  expandedPaths: ReadonlySet<string>;
  scope: string;
  source: StreamTreeSource;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
};

function AdminRemoteStreamTreeNode({
  path,
  depth,
  tree,
}: {
  path: string;
  depth: number;
  tree: AdminRemoteTreeContext;
}) {
  const expanded = tree.expandedPaths.has(path);
  const { data, isError, isPending, refetch } = useQuery({
    queryKey: ["admin-remote-stream-tree", tree.scope, path],
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
          isPending && "animate-pulse",
        )}
      >
        <span style={{ width: depth * 14 }} className="shrink-0" />
        {isError ? (
          <button
            type="button"
            aria-label={`Retry loading ${path}`}
            title="Failed to load this stream's state — click to retry"
            className="-m-1 shrink-0 rounded p-1 text-destructive hover:bg-muted"
            onClick={() => void refetch()}
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        ) : childPaths.length > 0 ? (
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
          {isError ? (
            <span className="ml-auto shrink-0 text-[10px] text-destructive">failed to load</span>
          ) : data == null ? null : (
            <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {data.eventCount}
            </span>
          )}
        </button>
      </div>
      {expanded
        ? childPaths.map((childPath) => (
            <AdminRemoteStreamTreeNode
              key={childPath}
              path={childPath}
              depth={depth + 1}
              tree={tree}
            />
          ))
        : null}
    </>
  );
}
