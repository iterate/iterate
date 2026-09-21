// One row of the stream: the gutter every event shares — offset, who, when, how long after the one
// before — and the body: a renderer's rich rendering when the app plugged one in for the type, else
// the type and a one-line glance at the payload. Click opens the inspector.
import { cn } from "../../lib/utils.ts";
import { actorLabel, payloadPreview, shortEventType } from "./filters.tsx";
import { type ContextViewEvent, type EventRenderers, rendererFor } from "./types.tsx";

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
  selected,
  onOpen,
}: {
  event: ContextViewEvent;
  previous?: ContextViewEvent;
  renderers?: EventRenderers;
  selected?: boolean;
  onOpen: (offset: number) => void;
}) {
  const at = Date.parse(event.createdAt);
  const delta = previous ? at - Date.parse(previous.createdAt) : 0;
  const rich = rendererFor(renderers, event.type)?.(event) ?? null;
  const who = actorLabel(event);
  return (
    <button
      type="button"
      onClick={() => onOpen(event.offset)}
      data-offset={event.offset}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60 sm:flex-row sm:items-baseline sm:gap-3",
        selected && "bg-muted",
      )}
    >
      <span className="flex shrink-0 items-baseline gap-3 font-mono text-xs text-muted-foreground/70 sm:w-40">
        <span className="w-10">#{event.offset}</span>
        <span className="tabular-nums">{formatClockTime(at)}</span>
        <span className="tabular-nums">{previous ? formatDelta(delta) : ""}</span>
      </span>
      <span className="min-w-0 flex-1 text-sm">
        {rich ?? (
          <>
            <span className="font-mono text-xs">{shortEventType(event.type)}</span>
            {event.payload === undefined ? null : (
              <span className="ml-2 truncate font-mono text-xs text-muted-foreground">
                {payloadPreview(event.payload)}
              </span>
            )}
          </>
        )}
      </span>
      {who ? (
        <span className="shrink-0 truncate text-xs text-muted-foreground sm:max-w-48">{who}</span>
      ) : null}
    </button>
  );
}
