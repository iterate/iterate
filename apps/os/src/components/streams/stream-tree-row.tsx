import { ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { Row } from "@tanstack/react-table";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { cn } from "@iterate-com/ui/lib/utils";
import { formatEventCount, streamTreeLabel, type StreamTreeNode } from "./stream-tree-table.ts";

export function StreamTreeHeader({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_5.5rem] gap-3 border-b px-3 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase",
        className,
      )}
      aria-hidden
    >
      <span>Stream</span>
      <span className="text-right">Events</span>
    </div>
  );
}

export function StreamTreeRowContent({
  row,
  onOpen,
  onRetry,
  onToggleExpanded,
  selected = false,
}: {
  row: Row<StreamTreeNode>;
  onOpen?: (path: string) => void;
  onRetry?: (path: string) => void;
  onToggleExpanded?: (path: string) => void;
  selected?: boolean;
}) {
  const node = row.original;
  const hasChildren = row.getCanExpand();
  const label = (
    <>
      <EventsStreamPathLabel
        path={node.path}
        label={streamTreeLabel(node.path)}
        className="text-xs"
      />
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-foreground/70">
        {node.loadState === "error"
          ? "failed to load"
          : node.eventCount === undefined
            ? null
            : formatEventCount(node.eventCount)}
      </span>
    </>
  );

  return (
    <>
      <span style={{ width: Math.min(row.depth, 8) * 12 }} className="shrink-0" aria-hidden />
      <span className="flex w-4 shrink-0 justify-center">
        {node.loadState === "error" ? (
          <button
            type="button"
            aria-label={`Retry loading ${node.path}`}
            title="Failed to load this stream's state — click to retry"
            className="-m-1 flex size-4 items-center justify-center rounded-sm text-destructive hover:bg-muted"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRetry?.(node.path);
            }}
          >
            <RefreshCw className="size-3.5" />
          </button>
        ) : node.loadState === "loading" ? (
          <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
        ) : hasChildren && onToggleExpanded !== undefined ? (
          <button
            type="button"
            aria-label={row.getIsExpanded() ? `Collapse ${node.path}` : `Expand ${node.path}`}
            aria-expanded={row.getIsExpanded()}
            className="-m-1 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleExpanded(node.path);
            }}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", row.getIsExpanded() && "rotate-90")}
            />
          </button>
        ) : hasChildren ? (
          <span
            data-stream-disclosure
            className="-m-1 flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"
            title={row.getIsExpanded() ? "Collapse child streams" : "Expand child streams"}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", row.getIsExpanded() && "rotate-90")}
            />
          </span>
        ) : null}
      </span>
      {onOpen === undefined ? (
        <span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
      ) : (
        <button
          type="button"
          aria-current={selected ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onOpen(node.path)}
        >
          {label}
        </button>
      )}
    </>
  );
}
