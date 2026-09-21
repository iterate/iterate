// One row of the stream, ONE line that never runs past the view: the gutter every event shares —
// offset, when, how long after the one before — then the body, then who. The body in `rendered`
// mode is a renderer's sentence for the type (the platform's own events come with theirs), else the
// type and a glance at the payload's fields; in `raw` mode the type and the payload's JSON. Anything
// longer than the line is cut with an ellipsis — the inspector (click) shows the whole event.
import { cn } from "../../lib/utils.ts";
import { actorLabel, payloadPreview, payloadSummary, shortEventType } from "./filters.tsx";
import {
  type ContextViewEvent,
  type ContextViewMode,
  type EventRenderers,
  rendererFor,
} from "./types.tsx";

function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDelta(ms: number): string {
  if (ms < 1000) return `+${String(ms)}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `+${String(Math.round(ms / 60_000))}m`;
  return `+${(ms / 3_600_000).toFixed(1)}h`;
}

export function EventRow({
  event,
  previous,
  renderers,
  mode,
  selected,
  onOpen,
}: {
  event: ContextViewEvent;
  previous?: ContextViewEvent;
  renderers?: EventRenderers;
  mode: ContextViewMode;
  selected?: boolean;
  onOpen: (offset: number) => void;
}) {
  const at = Date.parse(event.createdAt);
  const rich = mode === "rendered" ? (rendererFor(renderers, event.type)?.(event) ?? null) : null;
  const who = actorLabel(event);
  return (
    <button
      type="button"
      onClick={() => onOpen(event.offset)}
      data-offset={event.offset}
      className={cn(
        "flex w-full min-w-0 items-baseline gap-3 overflow-hidden rounded-md px-2 py-1 text-left hover:bg-muted/60",
        selected && "bg-muted",
      )}
    >
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-[11px] text-muted-foreground/70 tabular-nums">
        <span className="w-10">#{event.offset}</span>
        <span className="hidden w-16 sm:inline">{formatClockTime(at)}</span>
        <span className="hidden w-14 md:inline">
          {previous ? formatDelta(at - Date.parse(previous.createdAt)) : ""}
        </span>
      </span>
      {/* every child inline, so the line truncates as one — a renderer's <strong> and <span> too */}
      <span className="min-w-0 flex-1 truncate text-sm whitespace-nowrap [&_*]:inline">
        {rich ?? <DefaultBody event={event} mode={mode} />}
      </span>
      {who ? (
        <span className="hidden max-w-40 shrink-0 truncate text-xs text-muted-foreground lg:inline">
          {who}
        </span>
      ) : null}
    </button>
  );
}

function DefaultBody({ event, mode }: { event: ContextViewEvent; mode: ContextViewMode }) {
  const glance = mode === "raw" ? payloadPreview(event.payload) : payloadSummary(event.payload);
  return (
    <>
      <span className="font-mono text-xs text-foreground/80">{shortEventType(event.type)}</span>
      {glance ? (
        <span className={cn("ml-2 text-xs text-muted-foreground", mode === "raw" && "font-mono")}>
          {glance}
        </span>
      ) : null}
    </>
  );
}
