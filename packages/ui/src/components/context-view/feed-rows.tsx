// The rows that are not one event: the day mark, a repeated fact with its count, a run of the
// platform's housekeeping folded quiet. The two folds open in place on a click; an opened member
// row opens the inspector like any row.
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import { housekeepingSummary } from "./core-renderers.tsx";
import { EventRow, EventSentence, formatClockTime, RowGutter } from "./event-row.tsx";
import { actorLabel } from "./filters.tsx";
import type { ContextViewEvent, EventRenderers } from "./types.tsx";

export function DaySeparator({ date }: { date: Date }) {
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
    <div className="flex items-center gap-3 px-2 pt-4 pb-1 first:pt-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
  );
}

/** The same fact `events.length` times in a row: its sentence once, the count, the span of time. */
export function RepeatRow({
  events,
  previous,
  renderers,
  showWho,
  open,
  onToggle,
  selected,
  onOpen,
}: {
  events: ContextViewEvent[];
  previous?: ContextViewEvent;
  renderers?: EventRenderers;
  showWho: boolean;
  open: boolean;
  onToggle: () => void;
  selected?: number;
  onOpen: (offset: number) => void;
}) {
  const first = events[0]!;
  const last = events.at(-1)!;
  const who = actorLabel(first);
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-start gap-3 overflow-hidden rounded-md px-2 py-1 text-left hover:bg-muted/60"
      >
        <RowGutter event={first} previous={previous} />
        <span className="flex min-w-0 flex-1 items-start gap-2">
          <EventSentence event={first} renderers={renderers} className="min-w-0 flex-1" />
          <span
            className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums"
            title={`${String(events.length)} times, ${formatClockTime(Date.parse(first.createdAt))} – ${formatClockTime(Date.parse(last.createdAt))}`}
          >
            ×{events.length}
          </span>
          <Chevron open={open} />
        </span>
        {showWho && who ? (
          <span className="hidden max-w-40 shrink-0 truncate pt-px text-xs text-muted-foreground md:inline">
            {who}
          </span>
        ) : null}
      </button>
      {open
        ? events.map((event, index) => (
            <EventRow
              key={event.offset}
              event={event}
              previous={index === 0 ? previous : events[index - 1]}
              renderers={renderers}
              mode="pretty-raw"
              showWho={false}
              selected={selected === event.offset}
              onOpen={onOpen}
            />
          ))
        : null}
    </>
  );
}

/** A run of the platform's housekeeping: one quiet line saying how much of what; open for the rows. */
export function HousekeepingRow({
  events,
  previous,
  renderers,
  open,
  onToggle,
  selected,
  onOpen,
}: {
  events: ContextViewEvent[];
  previous?: ContextViewEvent;
  renderers?: EventRenderers;
  open: boolean;
  onToggle: () => void;
  selected?: number;
  onOpen: (offset: number) => void;
}) {
  const first = events[0]!;
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex w-full min-w-0 items-start gap-3 overflow-hidden rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-muted/60",
        )}
      >
        <RowGutter event={first} previous={previous} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2 text-xs">
          <span className="truncate">
            {events.length} housekeeping events{" "}
            <span className="text-muted-foreground/70">
              · {housekeepingSummary(events.map((e) => e.type))}
            </span>
          </span>
          <Chevron open={open} />
        </span>
      </button>
      {open
        ? events.map((event, index) => (
            <EventRow
              key={event.offset}
              event={event}
              previous={index === 0 ? previous : events[index - 1]}
              renderers={renderers}
              mode="pretty"
              showWho={false}
              quiet
              selected={selected === event.offset}
              onOpen={onOpen}
            />
          ))
        : null}
    </>
  );
}
