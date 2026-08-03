import { useState } from "react";
import { cn } from "@iterate-com/ui/lib/utils";
import { StreamTreeHeader, StreamTreeRowContent } from "./stream-tree-row.tsx";
import { useRemoteStreamTreeTable } from "./stream-tree-table.ts";
import type { StreamTreeSource } from "~/lib/stream-navigation.ts";
import { streamPathAncestors } from "~/lib/stream-links.ts";
import { toggledSet } from "~/lib/tree-rows.ts";

/**
 * Lazy stream table for admin/operator surfaces, whose remote or deployment
 * streams do not have the product project's materialized live-state index.
 */
export function RemoteStreamTable({
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
  const [expansion, setExpansion] = useState<{
    currentPath: string;
    paths: ReadonlySet<string>;
    scope: string;
  }>(() => ({
    currentPath,
    paths: new Set(["/", ...streamPathAncestors(currentPath)]),
    scope,
  }));
  let currentExpansion = expansion;
  if (expansion.scope !== scope) {
    currentExpansion = {
      currentPath,
      paths: new Set(["/", ...streamPathAncestors(currentPath)]),
      scope,
    };
    setExpansion(currentExpansion);
  } else if (expansion.currentPath !== currentPath) {
    currentExpansion = {
      ...expansion,
      currentPath,
      paths: new Set([...expansion.paths, "/", ...streamPathAncestors(currentPath)]),
    };
    setExpansion(currentExpansion);
  }
  const expandedPaths = currentExpansion.paths;
  const { table, retryPath } = useRemoteStreamTreeTable({
    currentPath,
    expandedPaths,
    scope,
    source,
  });

  return (
    <div className="min-w-0">
      <StreamTreeHeader className="sticky top-0 z-10 bg-background" />
      <ul aria-label="Streams" className="p-1">
        {table.getRowModel().rows.map((row) => {
          const selected = currentPath === row.original.path;
          return (
            <li
              key={row.id}
              data-stream-path={row.original.path}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-xs",
                selected ? "bg-accent" : "hover:bg-accent/70",
                row.original.loadState === "loading" && "animate-pulse",
              )}
            >
              <StreamTreeRowContent
                row={row}
                onOpen={onOpenPath}
                onRetry={retryPath}
                selected={selected}
                onToggleExpanded={(path) =>
                  setExpansion((previous) => ({
                    ...previous,
                    paths: toggledSet(previous.paths, path),
                  }))
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
