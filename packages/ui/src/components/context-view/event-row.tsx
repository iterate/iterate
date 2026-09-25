// One row of the stream, ONE line that never runs past the view on a desktop (two on a phone), read
// like a log, left to right in fixed columns: `#offset` in a muted gutter sized to the log's largest
// offset (`--offset-width`, set by the view), the clock, the gap since the row before (blank under a
// second; coloured by its size, so a long pause runs hot), the body, and who — when it is not who
// acted on the row before. No rule between rows: the hover and the inspected row's 2px bar are
// enough. On a phone the body comes first and the rest is one muted line under it. The body in
// Pretty is a renderer's sentence for the type (the platform's own come with theirs — the
// lifecycle's are ordinary muted sentences, a wake purple), else the type and a glance at the
// payload's fields; Pretty + raw adds the raw line under it; Raw is the raw line, the type in a
// fixed column. What a line cuts the inspector (click) shows whole.
import { memo } from "react";
import { cn } from "cn";
import { actorLabel, payloadPreview, payloadSummary, shortEventType } from "./filters.tsx";
import {
  type ContextViewEvent,
  type ContextViewMode,
  type EventRenderers,
  rendererFor,
} from "./types.tsx";

/** The row's clock: `19:36:58` in the reader's zone, always the 24-hour cycle — eight characters
 *  that fit the fixed column in every locale (a 12-hour locale's ` PM` would run into the delta). */
export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

/** `+950ms`, `+3.2s`, `+1m40s`, `+2h5m` — the old feed's compact gap. */
export function formatDelta(ms: number): string {
  if (ms < 1_000) return `+${String(ms)}ms`;
  if (ms < 60_000) return `+${(Math.floor(ms / 100) / 10).toFixed(1).replace(/\.0$/, "")}s`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 3_600) return `+${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`;
  const minutes = Math.floor(seconds / 60);
  return `+${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
}

/** The gap's colour by its size: a second or more is green, then amber, orange, and a pause of
 *  ten minutes or more red — where the log went quiet stands out. */
function deltaColor(ms: number): string {
  if (ms < 10_000) return "text-emerald-600";
  if (ms < 60_000) return "text-amber-600";
  if (ms < 600_000) return "text-orange-600";
  return "text-red-600";
}

/** The frame every row shares: full width, the columns on one line from `sm` (a phone wraps the
 *  body above the rest), 26px tall, the hover, the inspected row's left bar. Rows are buttons
 *  (inspect, or open a fold). */
export const rowClass = (selected?: boolean) =>
  cn(
    "flex w-full min-w-0 flex-wrap items-baseline gap-x-3.5 px-3 sm:px-4 py-[3px] text-left hover:bg-muted/60 max-sm:gap-x-2 max-sm:py-1.5 sm:flex-nowrap",
    selected && "bg-muted shadow-[inset_2px_0_0_var(--color-foreground)] hover:bg-muted",
  );

const OFFSET =
  "shrink-0 font-mono text-[11px] text-muted-foreground/60 tabular-nums sm:w-[var(--offset-width,6ch)] sm:text-right";
const CLOCK = "shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums sm:w-[8ch]";
const GAP =
  "shrink-0 font-mono text-[11px] tabular-nums max-sm:empty:hidden sm:w-[7ch] sm:text-right";

/** `#123`, right-aligned in the gutter the view sizes to its largest offset (`--offset-width`). */
export function RowOffset({ offset }: { offset: number }) {
  return <span className={OFFSET}>#{offset}</span>;
}

/** The empty columns before the body (the offset, and with `times` the clock and the gap), so a
 *  line that is not an event — a day, the top of the log, the composer — starts where they do. */
export function RowGutter({ times }: { times?: boolean }) {
  return (
    <>
      <span aria-hidden className={cn(OFFSET, "max-sm:hidden")} />
      {times ? (
        <>
          <span aria-hidden className={cn(CLOCK, "max-sm:hidden")} />
          <span aria-hidden className={cn(GAP, "max-sm:hidden")} />
        </>
      ) : null}
    </>
  );
}

/** Who acted, when it changes hands: the right edge on a desktop, the meta line on a phone. */
export function RowWho({ who }: { who: string }) {
  return (
    <span className="max-w-48 shrink-0 truncate text-xs text-muted-foreground max-sm:font-mono max-sm:text-[11px] sm:ml-auto">
      {who}
    </span>
  );
}

/** The clock and the gap since the row before (from its LAST moment, so a fold's gap is the idle
 *  time between rows, not inside one): two columns, the gap blank under a second. */
export function RowTimes({
  event,
  previous,
}: {
  event: ContextViewEvent;
  previous?: ContextViewEvent;
}) {
  const at = Date.parse(event.createdAt);
  const gap = previous ? Math.max(0, at - Date.parse(previous.createdAt)) : undefined;
  return (
    <>
      <time dateTime={event.createdAt} title={new Date(at).toISOString()} className={CLOCK}>
        {formatClockTime(at)}
      </time>
      <span className={cn(GAP, gap !== undefined && deltaColor(gap))} title="Since the row before">
        {gap === undefined || gap < 1_000 ? "" : formatDelta(gap)}
      </span>
    </>
  );
}

/** The body column: first on a phone, where it takes the whole first line. */
export const rowBody = "min-w-0 flex-1 max-sm:order-first max-sm:basis-full";

/** The raw line: the type and the payload's JSON, one line. */
export function RawLine({ event, className }: { event: ContextViewEvent; className?: string }) {
  const glance = payloadPreview(event.payload);
  return (
    <span
      className={cn(
        "flex min-w-0 gap-3 font-mono text-xs leading-5 text-muted-foreground",
        className,
      )}
    >
      <span className="w-[26ch] shrink-0 truncate text-foreground/85">
        {shortEventType(event.type)}
      </span>
      {glance ? <span className="min-w-0 truncate">{glance}</span> : null}
    </span>
  );
}

/** The sentence: a renderer's for the type, else the type with a glance at the payload's fields.
 *  Every child is forced inline so the line truncates as one — a renderer's <strong> and <span> too. */
export function EventSentence({
  event,
  renderers,
  className,
}: {
  event: ContextViewEvent;
  renderers?: EventRenderers;
  className?: string;
}) {
  const rich = rendererFor(renderers, event.type)?.(event) ?? null;
  const glance = payloadSummary(event.payload);
  return (
    <span
      className={cn(
        // a phone gets two lines, a desktop one — never a third, never a sideways scroll
        "block max-h-10 min-w-0 overflow-hidden text-sm leading-5 whitespace-normal sm:max-h-none sm:truncate [&_*]:inline",
        className,
      )}
    >
      {rich ?? (
        <>
          <span className="font-mono text-xs text-foreground/80">{shortEventType(event.type)}</span>
          {glance ? <span className="ml-2 text-xs text-muted-foreground">{glance}</span> : null}
        </>
      )}
    </span>
  );
}

export const EventRow = memo(function EventRow({
  event,
  previous,
  renderers,
  mode,
  showWho,
  quiet,
  selected,
  onOpen,
}: {
  event: ContextViewEvent;
  previous?: ContextViewEvent;
  renderers?: EventRenderers;
  mode: ContextViewMode;
  /** Whether to name who acted — false when the row before was theirs too. */
  showWho: boolean;
  /** Housekeeping expanded out of its fold reads muted. */
  quiet?: boolean;
  selected?: boolean;
  onOpen: (offset: number) => void;
}) {
  const who = actorLabel(event);
  return (
    <button
      type="button"
      onClick={() => onOpen(event.offset)}
      data-offset={event.offset}
      className={cn(rowClass(selected), quiet && "text-muted-foreground")}
    >
      <RowOffset offset={event.offset} />
      <RowTimes event={event} previous={previous} />
      <span className={rowBody}>
        {mode === "raw" ? (
          <RawLine event={event} />
        ) : (
          <EventSentence event={event} renderers={renderers} />
        )}
        {mode === "pretty-raw" ? <RawLine event={event} className="mt-0.5 text-[11px]" /> : null}
      </span>
      {showWho && who ? <RowWho who={who} /> : null}
    </button>
  );
});
