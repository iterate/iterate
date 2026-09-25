// The rows that are not one event: the day mark (a plain word over the clock column, no rule), a
// repeated fact with a small count, a run of the platform's housekeeping folded into one quiet line
// ("2 housekeeping · woke, subscription"). The two folds open in place on a click: the feed lists
// their members under them as rows of their own (feed-list.tsx), each opening the inspector like
// any row. Memoised, like every row: the feed re-renders on every scroll frame.
import { memo } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import { housekeepingSummary } from "./core-renderers.tsx";
import {
  EventSentence,
  formatClockTime,
  RowGutter,
  RowOffset,
  RowTimes,
  RowWho,
  rowBody,
  rowClass,
} from "./event-row.tsx";
import { actorLabel } from "./filters.tsx";
import type { ContextViewEvent, EventRenderers } from "./types.tsx";

export const DaySeparator = memo(function DaySeparator({ date }: { date: Date }) {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const label =
    date.toDateString() === today.toDateString()
      ? "Today"
      : date.toDateString() === yesterday.toDateString()
        ? "Yesterday"
        : date.toLocaleDateString(undefined, {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
          });
  return (
    <div className="flex items-baseline gap-x-3.5 px-3 sm:px-4 pt-3 pb-1">
      <RowGutter />
      <span className="text-xs font-semibold text-foreground/75">{label}</span>
    </div>
  );
});

function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDownIcon className="size-3 shrink-0 self-center text-muted-foreground/70" />
  ) : (
    <ChevronRightIcon className="size-3 shrink-0 self-center text-muted-foreground/70" />
  );
}

/** The same fact `events.length` times in a row: its sentence once, the count, the span of time. */
export const RepeatRow = memo(function RepeatRow({
  itemKey,
  events,
  previous,
  renderers,
  showWho,
  open,
  onToggle,
}: {
  /** The fold's key, handed back to `onToggle`. */
  itemKey: string;
  events: ContextViewEvent[];
  previous?: ContextViewEvent;
  renderers?: EventRenderers;
  showWho: boolean;
  open: boolean;
  onToggle: (itemKey: string) => void;
}) {
  const first = events[0]!;
  const last = events.at(-1)!;
  const who = actorLabel(first);
  return (
    <button
      type="button"
      onClick={() => onToggle(itemKey)}
      aria-expanded={open}
      className={rowClass()}
    >
      <RowOffset offset={first.offset} />
      <RowTimes event={first} previous={previous} />
      <span className={cn(rowBody, "flex items-baseline gap-1.5")}>
        <EventSentence event={first} renderers={renderers} className="min-w-0" />
        <span
          className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
          title={`${String(events.length)} times, ${formatClockTime(Date.parse(first.createdAt))} – ${formatClockTime(Date.parse(last.createdAt))}`}
        >
          ×{events.length}
        </span>
        <Chevron open={open} />
      </span>
      {showWho && who ? <RowWho who={who} /> : null}
    </button>
  );
});

/** A run of the platform's housekeeping: one quiet line saying how much of what; open for the rows. */
export const HousekeepingRow = memo(function HousekeepingRow({
  itemKey,
  events,
  previous,
  open,
  onToggle,
}: {
  /** The fold's key, handed back to `onToggle`. */
  itemKey: string;
  events: ContextViewEvent[];
  previous?: ContextViewEvent;
  open: boolean;
  onToggle: (itemKey: string) => void;
}) {
  const first = events[0]!;
  return (
    <button
      type="button"
      onClick={() => onToggle(itemKey)}
      aria-expanded={open}
      className={cn(rowClass(), "text-muted-foreground")}
    >
      <RowOffset offset={first.offset} />
      <RowTimes event={first} previous={previous} />
      <span className={cn(rowBody, "flex items-baseline gap-1 text-[13px]")}>
        <Chevron open={open} />
        <span className="truncate">
          {events.length} housekeeping · {housekeepingSummary(events.map((e) => e.type))}
        </span>
      </span>
    </button>
  );
});
