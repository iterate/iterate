import { useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { cn } from "@iterate-com/ui/lib/utils";
import { buildStreamForest, flattenStreamRows, toggled } from "./command-palette-model.ts";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";
import { streamPathAncestors } from "~/lib/stream-links.ts";

const MAX_VISIBLE_STREAM_ROWS = 250;

/** A compact tree backed by the project's one materialized stream index. */
export function StreamIndexTree({
  currentPath,
  onOpenPath,
  rootPath = "/",
  streams,
}: {
  currentPath?: string;
  onOpenPath: (streamPath: string) => void;
  rootPath?: string;
  streams: Record<string, StreamIndexRow>;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set([rootPath, ...(currentPath ? streamPathAncestors(currentPath) : [])]),
  );
  const scopedStreams = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(streams).filter(
          ([path]) => path === rootPath || path.startsWith(`${rootPath}/`),
        ),
      ),
    [rootPath, streams],
  );
  const rows = useMemo(
    () => flattenStreamRows(buildStreamForest(scopedStreams), expandedPaths, ""),
    [expandedPaths, scopedStreams],
  );
  const visibleRows = rows.slice(0, MAX_VISIBLE_STREAM_ROWS);

  if (visibleRows.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No streams yet.</p>;
  }

  return (
    <div>
      <ul className="space-y-0.5">
        {visibleRows.map(({ node, depth }) => {
          const expanded = expandedPaths.has(node.row.path);
          return (
            <li key={node.row.path}>
              <div
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5",
                  currentPath === node.row.path ? "bg-accent" : "hover:bg-accent/70",
                )}
              >
                <span style={{ width: Math.min(depth, 6) * 14 }} className="shrink-0" />
                {node.children.length > 0 ? (
                  <button
                    type="button"
                    aria-label={expanded ? `Collapse ${node.row.path}` : `Expand ${node.row.path}`}
                    className="-m-1 shrink-0 rounded p-1 hover:bg-muted"
                    onClick={() => setExpandedPaths((current) => toggled(current, node.row.path))}
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-3.5 text-muted-foreground/60 transition-transform",
                        expanded && "rotate-90",
                      )}
                    />
                  </button>
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => onOpenPath(node.row.path)}
                >
                  <EventsStreamPathLabel
                    path={node.row.path}
                    label={
                      node.row.path === "/"
                        ? "/"
                        : (node.row.path.split("/").at(-1) ?? node.row.path)
                    }
                    className="min-w-0"
                  />
                  <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                    {node.row.eventCount}
                  </span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {rows.length > visibleRows.length ? (
        <p className="px-2 pt-2 text-[10px] text-muted-foreground">
          Showing the first {MAX_VISIBLE_STREAM_ROWS} visible streams. Use ⌘K to search all streams.
        </p>
      ) : null}
    </div>
  );
}
