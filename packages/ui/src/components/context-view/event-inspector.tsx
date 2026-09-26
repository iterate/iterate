// The inspector: one event, whole, in a right-edge sheet (full width on a phone), paged through the
// loaded log — the old platform's raw-event inspector (apps/os `raw-event-inspector-panel.tsx`,
// removed in #2837) over the view's sorted array instead of a SQLite mirror.
// - PAGING: Prev / Next and ← → move to the neighbouring event of the whole loaded log (not the
//   filter's — the old one paged the log too), each a `state.event` patch, so the URL follows and
//   every step is a link. The keys are heard on the window in the capture phase: Base UI's popup
//   (our Sheet) stops ← → on bubble for its nested composites. A field or editor with focus keeps
//   its arrows; a modifier (⌘←, ⇧→) is never a page. ← on the oldest loaded event reads the page
//   below and steps onto it once it lands.
// - A LINK TO AN EVENT NOT LOADED (`?event=5` on a 100,000 event log, whose newest page is all that
//   is read) reads older pages until it is, rather than showing nothing; an offset no event has (an
//   ephemeral one, a typo) says so and offers its neighbours.
// - THE HEADER: the event's sentence (or short type; the full type on hover), `#offset · N loaded ·
//   when`, and the gap to the previous and to the next event (`+166ms · +28ms to next`).
// - THE BODY: a rich inspector when one is registered for the type (the message as prose, the
//   script as code), who and on what grant, then the raw event in the read-only CodeMirror block —
//   YAML first, keys signal first (type, payload, then the envelope), a YAML/JSON toggle, copy
//   either, fold, ⌘F search.
// - CLOSING keeps the last event painted through the sheet's exit slide, with paging off.
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "../button.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../sheet.tsx";
import { SerializedObjectCodeBlock } from "../code-block.tsx";
import { Spinner } from "../spinner.tsx";
import {
  elapsedBetween,
  inspectedPlace,
  isTypingTarget,
  orderEventKeys,
} from "./event-inspector-log.ts";
import { actorLabel, shortEventType } from "./filters.tsx";
import {
  type ContextViewEvent,
  type EventInspectors,
  type EventRenderers,
  rendererFor,
} from "./types.tsx";

export function EventInspector({
  events,
  offset,
  older,
  renderers,
  inspectors,
  onNavigate,
  onClose,
}: {
  /** The loaded log, sorted by offset. */
  events: readonly ContextViewEvent[];
  /** The inspected offset (`state.event`); undefined = closed. */
  offset: number | undefined;
  /** Reading the log below what is loaded. */
  older: { loadOlder(): void; loading: boolean; exhausted: boolean };
  renderers?: EventRenderers;
  inspectors?: EventInspectors;
  /** Inspect another offset — a `state.event` patch. */
  onNavigate: (offset: number) => void;
  onClose: () => void;
}) {
  const open = offset !== undefined;
  // the last offset inspected, painted while the sheet slides out after `offset` went undefined
  const [shown, setShown] = useState(offset);
  if (offset !== undefined && offset !== shown) setShown(offset);
  const place = useMemo(
    () => (shown === undefined ? undefined : inspectedPlace(events, shown)),
    [events, shown],
  );
  const { event, previous, next, missing } = place || {};
  const olderLeft = !older.exhausted;
  // ← pressed on the oldest loaded event: the offset it was pressed on, until the page below lands
  const [steppingBackFrom, setSteppingBackFrom] = useState<number>();
  const stepBack = () => {
    if (previous) onNavigate(previous.offset);
    else if (olderLeft && shown !== undefined) {
      setSteppingBackFrom(shown);
      older.loadOlder();
    }
  };
  const stepForward = () => next && onNavigate(next.offset);
  useEffect(() => {
    if (steppingBackFrom === undefined) return;
    if (steppingBackFrom !== shown) setSteppingBackFrom(undefined);
    else if (previous) {
      setSteppingBackFrom(undefined);
      onNavigate(previous.offset);
    } else if (older.exhausted) setSteppingBackFrom(undefined);
  }, [steppingBackFrom, shown, previous, older.exhausted, onNavigate]);
  // a link to an event older than the loaded pages: read on down to it
  const readingDown = open && missing === "below" && olderLeft;
  useEffect(() => {
    if (readingDown && !older.loading) older.loadOlder();
  }, [readingDown, older]);

  const onKey = useEffectEvent((key: KeyboardEvent) => {
    if (key.altKey || key.ctrlKey || key.metaKey || key.shiftKey) return;
    if (isTypingTarget(key.target)) return;
    if (key.key === "ArrowLeft" && (previous || olderLeft)) {
      key.preventDefault();
      stepBack();
    } else if (key.key === "ArrowRight" && next) {
      key.preventDefault();
      stepForward();
    }
  });
  useEffect(() => {
    if (!open) return;
    const listener = (key: KeyboardEvent) => onKey(key);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [open]);

  // a new object only when the event is another: CodeMirror rebuilds on a new document
  const raw = useMemo(() => (event ? orderEventKeys(event) : undefined), [event]);
  const sentence = event ? (rendererFor(renderers, event.type)?.(event) ?? null) : null;
  const body = event ? (rendererFor(inspectors, event.type)?.(event) ?? null) : null;
  const envelope: [label: string, value: string][] = event
    ? [
        ["Who", actorLabel(event)],
        ["From", event.source?.origin || ""],
        ["Grant", event.source?.grant || ""],
        ["Processor", causedByProcessor(event)],
      ].filter((row): row is [string, string] => Boolean(row[1]))
    : [];
  const sincePrevious = event && previous && elapsedBetween(previous.createdAt, event.createdAt);
  const untilNext = event && next && elapsedBetween(event.createdAt, next.createdAt);
  return (
    <Sheet open={open} onOpenChange={(opened) => !opened && onClose()}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        inert={!open}
      >
        {shown === undefined ? null : (
          <>
            <SheetHeader className="shrink-0 pr-12">
              <SheetTitle className="line-clamp-2 text-sm [&_*]:inline" title={event?.type}>
                {!event
                  ? `Event #${String(shown)}`
                  : (sentence ?? <span className="font-mono">{shortEventType(event.type)}</span>)}
              </SheetTitle>
              <SheetDescription className="font-mono text-xs">
                #{shown}
                {event && sentence ? ` · ${shortEventType(event.type)}` : ""} ·{" "}
                {events.length.toLocaleString()} loaded
                {event ? ` · ${event.createdAt}` : ""}
              </SheetDescription>
            </SheetHeader>
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3">
              <Button
                size="sm"
                variant="outline"
                disabled={!open || (!previous && !olderLeft)}
                onClick={stepBack}
              >
                {steppingBackFrom === undefined ? <ChevronLeftIcon /> : <Spinner />}
                Prev
              </Button>
              <Button size="sm" variant="outline" disabled={!open || !next} onClick={stepForward}>
                Next
                <ChevronRightIcon />
              </Button>
              <span className="hidden text-xs text-muted-foreground/70 sm:inline">
                ← → page the log
              </span>
              <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                {sincePrevious ? (
                  <span title="Since the previous event">{sincePrevious}</span>
                ) : null}
                {sincePrevious && untilNext ? <span>·</span> : null}
                {untilNext ? <span title="Until the next event">{untilNext} to next</span> : null}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t px-4 py-3">
              {!event ? (
                <p className="text-sm text-muted-foreground">
                  {readingDown ? (
                    <span className="flex items-center gap-2">
                      <Spinner /> Reading older events to reach #{shown}…
                    </span>
                  ) : missing === "above" ? (
                    `No event #${String(shown)} yet.`
                  ) : (
                    `No event has offset #${String(shown)}. Prev and Next go to its neighbours.`
                  )}
                </p>
              ) : (
                <>
                  {body ? <div className="min-w-0">{body}</div> : null}
                  {envelope.length > 0 ? (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                      {envelope.map(([label, value]) => (
                        <div key={label} className="contents">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="min-w-0 truncate font-mono" title={value}>
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  <div className="min-w-0">
                    <SerializedObjectCodeBlock data={raw} />
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The processor that says it wrote the event, from its own claim (`metadata.causedBy`, the SDK
 *  engine's): what it was processing, not who it is — that is the stamp's `origin`. */
function causedByProcessor(event: ContextViewEvent): string {
  const causedBy = event.metadata?.causedBy as { processor?: unknown } | undefined;
  return typeof causedBy?.processor === "string" ? causedBy.processor : "";
}
