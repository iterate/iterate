import { useEffect, useMemo } from "react";
import type { Event } from "@iterate-com/shared/streams/types";
import { BookOpenIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "@iterate-com/ui/components/button";
import { StreamEventType } from "@iterate-com/ui/components/events/stream-event-type";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";

/**
 * Raw event detail drawer shared by stream renderers.
 *
 * Feed rows only show compact summaries. This sheet owns the richer raw-event
 * inspection surface: full payload, previous/next navigation, elapsed timing,
 * and keyboard navigation through the wire log.
 */
export function EventsStreamEventInspectorSheet({
  events,
  openEventOffset,
  onOpenEventOffsetChange,
  getEventTypeHref,
}: {
  events: readonly Event[];
  openEventOffset?: number;
  onOpenEventOffsetChange?: (offset?: number) => void;
  getEventTypeHref?: (eventType: string) => string | undefined;
}) {
  const selectedEvent = useMemo(
    () => events.find((event) => event.offset === openEventOffset),
    [events, openEventOffset],
  );
  const previousOffset = useMemo(
    () => getAdjacentEventOffset(events, openEventOffset, "previous"),
    [events, openEventOffset],
  );
  const nextOffset = useMemo(
    () => getAdjacentEventOffset(events, openEventOffset, "next"),
    [events, openEventOffset],
  );
  const previousEvent = useMemo(
    () => events.find((event) => event.offset === previousOffset),
    [events, previousOffset],
  );
  const nextEvent = useMemo(
    () => events.find((event) => event.offset === nextOffset),
    [events, nextOffset],
  );
  const docsHref =
    selectedEvent == null || getEventTypeHref == null
      ? undefined
      : getEventTypeHref(selectedEvent.type);
  const timeSincePreviousEvent =
    selectedEvent && previousEvent
      ? formatElapsedTime(getTimestamp(selectedEvent) - getTimestamp(previousEvent))
      : undefined;
  const timeToNextEvent =
    selectedEvent && nextEvent
      ? formatElapsedTime(getTimestamp(nextEvent) - getTimestamp(selectedEvent))
      : undefined;

  useEffect(() => {
    if (selectedEvent == null) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (event.key === "ArrowLeft" && previousOffset != null) {
        event.preventDefault();
        onOpenEventOffsetChange?.(previousOffset);
      }

      if (event.key === "ArrowRight" && nextOffset != null) {
        event.preventDefault();
        onOpenEventOffsetChange?.(nextOffset);
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [nextOffset, onOpenEventOffsetChange, previousOffset, selectedEvent]);

  if (selectedEvent == null) {
    return null;
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          onOpenEventOffsetChange?.(undefined);
        }
      }}
    >
      <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(96vw,120rem)] data-[side=right]:sm:max-w-[min(96vw,120rem)]">
        <SheetHeader className="space-y-2 border-b px-4 py-3 pr-14">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <SheetTitle className="truncate font-mono text-sm">
                {selectedEvent == null ? (
                  "Event"
                ) : (
                  <StreamEventType
                    type={selectedEvent.type}
                    href={docsHref}
                    renderLink={({ href, className, children }) => (
                      <a href={href} className={className}>
                        {children}
                      </a>
                    )}
                    className="gap-2"
                  />
                )}
                {docsHref ? (
                  <span className="ml-1 inline-flex align-middle">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="inline-flex items-center text-muted-foreground hover:text-primary" />
                        }
                      >
                        <BookOpenIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Event docs</p>
                      </TooltipContent>
                    </Tooltip>
                  </span>
                ) : null}
              </SheetTitle>
              <SheetDescription>{selectedEvent?.createdAt ?? "No event selected"}</SheetDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={previousOffset == null}
                onClick={() => onOpenEventOffsetChange?.(previousOffset)}
              >
                <ChevronLeftIcon />
                Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={nextOffset == null}
                onClick={() => onOpenEventOffsetChange?.(nextOffset)}
              >
                Next
                <ChevronRightIcon />
              </Button>
            </div>
          </div>
          {selectedEvent ? (
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span>Event {selectedEvent.offset}</span>
                <span className="text-muted-foreground/70">Use left and right arrow keys.</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1">
                <span className="text-muted-foreground/70">Since previous</span>
                <span className="font-mono text-foreground">
                  {timeSincePreviousEvent ?? "No previous event"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1">
                <span className="text-muted-foreground/70">Until next</span>
                <span className="font-mono text-foreground">
                  {timeToNextEvent ?? "No next event"}
                </span>
              </div>
            </div>
          ) : null}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
          <div className="pb-2 text-xs text-muted-foreground">Raw event payload</div>
          <SerializedObjectCodeBlock
            data={selectedEvent == null ? null : orderEventKeysForYamlDisplay(selectedEvent)}
            className="h-full min-h-[68vh]"
            initialFormat="yaml"
            showToggle
            showCopyButton
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Finds the adjacent event offset in the raw wire log.
 */
export function getAdjacentEventOffset(
  events: readonly Event[],
  currentOffset: number | undefined,
  direction: "previous" | "next",
) {
  if (currentOffset == null) {
    return undefined;
  }

  const index = events.findIndex((event) => event.offset === currentOffset);

  if (index === -1) {
    return undefined;
  }

  const adjacentIndex = direction === "previous" ? index - 1 : index + 1;
  return events[adjacentIndex]?.offset;
}

function getTimestamp(event: Event) {
  return Number.isNaN(Date.parse(event.createdAt)) ? Date.now() : Date.parse(event.createdAt);
}

function formatElapsedTime(durationMs: number) {
  const normalizedDurationMs = Math.max(0, Math.floor(durationMs));

  if (normalizedDurationMs < 1_000) {
    return `+${normalizedDurationMs}ms`;
  }

  if (normalizedDurationMs < 60_000) {
    const seconds = Math.floor(normalizedDurationMs / 100) / 10;
    return `+${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  }

  const totalSeconds = Math.floor(normalizedDurationMs / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `+${totalMinutes}m${seconds}s`;
}

const EVENT_YAML_DISPLAY_KEY_ORDER = [
  "type",
  "payload",
  "metadata",
  "idempotencyKey",
  "offset",
  "createdAt",
] as const;

const EVENT_YAML_DISPLAY_KEY_SET = new Set<string>(EVENT_YAML_DISPLAY_KEY_ORDER);

function orderEventKeysForYamlDisplay(event: Event): Record<string, unknown> {
  const eventRecord = event as Record<string, unknown>;
  const orderedEvent: Record<string, unknown> = {};

  for (const key of EVENT_YAML_DISPLAY_KEY_ORDER) {
    if (key in eventRecord) {
      orderedEvent[key] = eventRecord[key];
    }
  }

  for (const [key, value] of Object.entries(eventRecord)) {
    if (key === "streamPath" || EVENT_YAML_DISPLAY_KEY_SET.has(key)) {
      continue;
    }

    orderedEvent[key] = value;
  }

  return orderedEvent;
}
