// One row of the stream, ONE line that never runs past the view on a desktop (two on a phone):
// when, then the body, then who — when it is not who acted on the row before. The body in Pretty
// is a renderer's sentence for the type (the platform's own events come with theirs), else the type
// and a glance at the payload's fields; Pretty + raw adds the raw line under it; Raw is the raw line.
// What a line cuts the inspector (click) shows whole. The offset is in the time's tooltip and in
// the inspector: people read the log by what happened, not by its numbers.
import { cn } from "../../lib/utils.ts";
import { actorLabel, payloadPreview, payloadSummary, shortEventType } from "./filters.tsx";
import {
  type ContextViewEvent,
  type ContextViewMode,
  type EventRenderers,
  rendererFor,
} from "./types.tsx";

/** The row's clock: `19:36:58` in the reader's zone, always the 24-hour cycle — eight characters
 *  that fit the fixed gutter in every locale (a 12-hour locale's ` PM` would run into the sentence). */
export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function formatDelta(ms: number): string {
  if (ms < 1000) return `+${String(ms)}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `+${String(Math.round(ms / 60_000))}m`;
  return `+${(ms / 3_600_000).toFixed(1)}h`;
}

/** The gutter every row shares: the clock (the offset in its tooltip), the gap since the row before. */
export function RowGutter({
  event,
  previous,
}: {
  event: ContextViewEvent;
  previous?: ContextViewEvent;
}) {
  const at = Date.parse(event.createdAt);
  return (
    <span className="flex shrink-0 items-baseline gap-2 pt-px font-mono text-[11px] text-muted-foreground/70 tabular-nums">
      <time
        dateTime={event.createdAt}
        title={`#${String(event.offset)} · ${new Date(at).toISOString()}`}
        className="w-14"
      >
        {formatClockTime(at)}
      </time>
      <span className="hidden w-12 md:inline">
        {previous ? formatDelta(at - Date.parse(previous.createdAt)) : ""}
      </span>
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

export function EventRow({
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
      className={cn(
        "flex w-full min-w-0 items-start gap-3 overflow-hidden rounded-md px-2 py-1 text-left hover:bg-muted/60",
        quiet && "text-muted-foreground",
        selected && "bg-muted",
      )}
    >
      <RowGutter event={event} previous={previous} />
      <span className="min-w-0 flex-1">
        {mode === "raw" ? (
          <RawLine event={event} className="text-xs" />
        ) : (
          <EventSentence event={event} renderers={renderers} className={cn(quiet && "text-xs")} />
        )}
        {mode === "pretty-raw" ? <RawLine event={event} className="mt-0.5" /> : null}
      </span>
      {showWho && who ? (
        <span className="hidden max-w-40 shrink-0 truncate pt-px text-xs text-muted-foreground md:inline">
          {who}
        </span>
      ) : null}
    </button>
  );
}
