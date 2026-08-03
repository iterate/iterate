import { ChevronRight } from "lucide-react";
import type { Row } from "@tanstack/react-table";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { cn } from "@iterate-com/ui/lib/utils";
import { formatEventCount, streamTreeLabel, type StreamTreeNode } from "./stream-tree-table.ts";

const EVENTS_COLUMN_CLASS = "w-[5.5rem] shrink-0 text-right";

export function StreamTreeHeader({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-2 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase",
        className,
      )}
      aria-hidden
    >
      <span className="min-w-0 flex-1">Stream</span>
      <span className={EVENTS_COLUMN_CLASS}>Events</span>
    </div>
  );
}

export function StreamTreeRowContent({
  row,
  onOpen,
  onToggleExpanded,
  selected = false,
}: {
  row: Row<StreamTreeNode>;
  onOpen?: (path: string) => void;
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
      <span
        className={cn("ml-auto text-[11px] tabular-nums text-foreground/70", EVENTS_COLUMN_CLASS)}
      >
        {node.indexRow === undefined ? null : formatEventCount(node.indexRow.eventCount)}
      </span>
    </>
  );

  return (
    <>
      <span style={{ width: Math.min(row.depth, 8) * 12 }} className="shrink-0" aria-hidden />
      <span className="flex w-4 shrink-0 justify-center">
        {hasChildren && onToggleExpanded !== undefined ? (
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
