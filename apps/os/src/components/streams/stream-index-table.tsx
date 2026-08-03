import { useMemo, useState } from "react";
import { cn } from "@iterate-com/ui/lib/utils";
import { StreamTreeHeader, StreamTreeRowContent } from "./stream-tree-row.tsx";
import { useIndexedStreamTreeTable } from "./stream-tree-table.ts";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";
import { streamPathAncestors } from "~/lib/stream-links.ts";
import { toggledSet } from "~/lib/tree-rows.ts";

/** Static index status plus the shared index-backed table. Performs no I/O. */
export function StreamIndexTablePanel({
  available,
  currentPath,
  error,
  onOpenPath,
  streams,
}: {
  available: boolean;
  currentPath: string;
  error: boolean;
  onOpenPath: (streamPath: string) => void;
  streams: Record<string, StreamIndexRow> | undefined;
}) {
  if (!available) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Global streams do not have a project stream index.
      </p>
    );
  }
  if (streams === undefined) {
    return (
      <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
        {error ? "Project stream index unavailable." : "Waiting for project stream index…"}
      </p>
    );
  }
  return <StreamIndexTable currentPath={currentPath} onOpenPath={onOpenPath} streams={streams} />;
}

/**
 * Collapsible stream navigation backed exclusively by the project DO's
 * materialized stream index. Rows never fetch their own stream state.
 */
export function StreamIndexTable({
  currentPath,
  onOpenPath,
  streams,
}: {
  currentPath: string;
  onOpenPath: (streamPath: string) => void;
  streams: Record<string, StreamIndexRow>;
}) {
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(new Set());
  const currentParentPaths = useMemo(() => {
    if (currentPath === "/") return new Set<string>();
    return new Set(["/", ...streamPathAncestors(currentPath).slice(0, -1)]);
  }, [currentPath]);
  const initialCollapsedPaths = useMemo(
    () => new Set([...collapsedPaths].filter((path) => !currentParentPaths.has(path))),
    [collapsedPaths, currentParentPaths],
  );

  return (
    <StreamIndexTableRows
      key={currentPath}
      currentPath={currentPath}
      initialCollapsedPaths={initialCollapsedPaths}
      onCollapsedPathsChange={setCollapsedPaths}
      onOpenPath={onOpenPath}
      streams={streams}
    />
  );
}

function StreamIndexTableRows({
  currentPath,
  initialCollapsedPaths,
  onCollapsedPathsChange,
  onOpenPath,
  streams,
}: {
  currentPath: string;
  initialCollapsedPaths: ReadonlySet<string>;
  onCollapsedPathsChange: (paths: ReadonlySet<string>) => void;
  onOpenPath: (streamPath: string) => void;
  streams: Record<string, StreamIndexRow>;
}) {
  const [visibleCollapsedPaths, setVisibleCollapsedPaths] = useState(initialCollapsedPaths);
  const table = useIndexedStreamTreeTable({
    streams,
    collapsedPaths: visibleCollapsedPaths,
    query: "",
  });
  const rows = table.getRowModel().rows;

  if (rows.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No indexed streams.</p>;
  }

  return (
    <div className="min-w-0">
      <StreamTreeHeader className="sticky top-0 z-10 bg-background" />
      <ul aria-label="Streams" className="p-1">
        {rows.map((row) => {
          const selected = currentPath === row.original.path;
          return (
            <li
              key={row.id}
              data-stream-path={row.original.path}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-xs",
                selected ? "bg-accent" : "hover:bg-accent/70",
              )}
            >
              <StreamTreeRowContent
                row={row}
                onOpen={row.original.indexed ? onOpenPath : undefined}
                selected={selected}
                onToggleExpanded={(path) => {
                  const nextCollapsedPaths = toggledSet(visibleCollapsedPaths, path);
                  setVisibleCollapsedPaths(nextCollapsedPaths);
                  onCollapsedPathsChange(nextCollapsedPaths);
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
