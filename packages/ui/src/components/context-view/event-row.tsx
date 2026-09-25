// One row of the stream, ONE line that never runs past the view on a desktop (two on a phone), in
// the old platform's feed's shape (apps/os `stream-feed-view.tsx` RawFeedItemRow, removed in #2837):
// `#offset` in a muted gutter sized to the log's largest offset, so the bodies line up; the body;
// who — when it is not who acted on the row before; then, right-aligned, the gap since the row
// before, coloured by how long it was (a long pause runs hot), and the clock. A hairline under each
// row, the whole row the inspector's trigger. The body in Pretty is a renderer's sentence for the
// type (the platform's own events come with theirs), else the type and a glance at the payload's
// fields; Pretty + raw adds the raw line under it; Raw is the raw line. The context's lifecycle —
// woke, paused, resumed, born, a child — reads in Pretty as a marker across the row (`markerToneOf`).
// What a line cuts the inspector (click) shows whole.
import { memo } from "react";
import { cn } from "cn";
import { markerToneOf, type MarkerTone } from "./core-renderers.tsx";
import { actorLabel, payloadPreview, payloadSummary, shortEventType } from "./filters.tsx";
import { sentenceText } from "./folds.tsx";
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

/** The gap's colour by its size: near-instant fades, a second or more is green, then amber,
 *  orange, and a pause of ten minutes or more red — where the log went quiet stands out. */
function deltaColor(ms: number): string {
  if (ms < 1_000) return "text-muted-foreground/40";
  if (ms < 10_000) return "text-emerald-600";
  if (ms < 60_000) return "text-amber-600";
  if (ms < 600_000) return "text-orange-600";
  return "text-red-600";
}

/** The frame every row shares: full width, a hairline under it, the hover, the inspected row's
 *  left bar. Rows are buttons (inspect, or open a fold). */
export const rowClass = (selected?: boolean) =>
  cn(
    "flex w-full min-w-0 items-baseline gap-3 overflow-hidden border-b border-border/40 px-2 py-1 text-left hover:bg-muted/60",
    selected && "bg-muted shadow-[inset_2px_0_0_var(--color-foreground)] hover:bg-muted",
  );

/** `#123`, right-aligned in the gutter the feed sizes to its largest offset (`--offset-width`). */
export function RowOffset({ offset }: { offset: number }) {
  return (
    <span className="w-[var(--offset-width,6ch)] shrink-0 text-right font-mono text-[11px] text-muted-foreground/60 tabular-nums">
      #{offset}
    </span>
  );
}

/** Who acted, when it changes hands. */
export function RowWho({ who }: { who: string }) {
  return (
    <span className="hidden max-w-40 shrink-0 truncate text-xs text-muted-foreground md:inline">
      {who}
    </span>
  );
}

/** The right edge: the gap since the row before (from its LAST moment, so a fold's gap is the idle
 *  time between rows, not inside one), coloured by its size, and the clock. */
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
    <span className="flex shrink-0 items-baseline gap-2 font-mono text-[10px] tabular-nums">
      <span
        className={cn("hidden w-12 text-right md:inline", gap !== undefined && deltaColor(gap))}
        title="Since the row before"
      >
        {gap === undefined ? "" : formatDelta(gap)}
      </span>
      <time
        dateTime={event.createdAt}
        title={new Date(at).toISOString()}
        className="text-muted-foreground/60"
      >
        {formatClockTime(at)}
      </time>
    </span>
  );
}

/** The raw line: the type and the payload's JSON, one line. */
export function RawLine({ event, className }: { event: ContextViewEvent; className?: string }) {
  const glance = payloadPreview(event.payload);
  return (
    <span className={cn("block truncate font-mono text-[11px] text-muted-foreground", className)}>
      <span className="text-foreground/80">{shortEventType(event.type)}</span>
      {glance ? <span className="ml-2">{glance}</span> : null}
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

const MARKER_LINE: Record<MarkerTone, string> = {
  wake: "bg-purple-500/40",
  lifecycle: "bg-border",
};
const MARKER_TEXT: Record<MarkerTone, string> = {
  wake: "font-mono text-purple-700",
  lifecycle: "rounded-full bg-muted px-2 text-muted-foreground",
};

/** A lifecycle marker's body: the sentence's words centred on a rule across the row (the old feed's
 *  "Stream durable object woke" divider, purple; a pause, a resume, a birth, neutral). */
function Marker({ tone, text }: { tone: MarkerTone; text: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 self-center">
      <span className={cn("h-px min-w-6 flex-1", MARKER_LINE[tone])} />
      <span className={cn("min-w-0 truncate text-xs", MARKER_TEXT[tone])}>{text}</span>
      <span className={cn("h-px min-w-6 flex-1", MARKER_LINE[tone])} />
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
  const tone = mode === "pretty" ? markerToneOf(event.type) : undefined;
  return (
    <button
      type="button"
      onClick={() => onOpen(event.offset)}
      data-offset={event.offset}
      className={cn(rowClass(selected), quiet && "text-muted-foreground")}
    >
      <RowOffset offset={event.offset} />
      {tone ? (
        <Marker
          tone={tone}
          text={
            sentenceText(rendererFor(renderers, event.type)?.(event)) || shortEventType(event.type)
          }
        />
      ) : (
        <span className="min-w-0 flex-1">
          {mode === "raw" ? (
            <RawLine event={event} className="text-xs" />
          ) : (
            <EventSentence event={event} renderers={renderers} className={cn(quiet && "text-xs")} />
          )}
          {mode === "pretty-raw" ? <RawLine event={event} className="mt-0.5" /> : null}
        </span>
      )}
      {showWho && who ? <RowWho who={who} /> : null}
      <RowTimes event={event} previous={previous} />
    </button>
  );
});
