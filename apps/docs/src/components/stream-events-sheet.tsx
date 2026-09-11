import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@iterate-com/ui/components/sheet";
import type { WorkspaceStreamEvent } from "../lib/docs-api.ts";
import { useStreamConnection, type StreamConnectionHandle } from "../lib/use-stream-connection.ts";

// One shared formatter: constructing a locale formatter per event per render
// is the slow path of toLocaleTimeString.
const eventTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * The workspace's platform stream, LIVE: the stream connection pushes
 * durable history and then every new commit over the retained callback —
 * no polling. Chronological (latest at the end), pinned to the bottom like
 * a log tail. Chrome mirrors the apps/os stream sheet: a mono stream path
 * in the header and the sheet's own close affordance.
 */
export function StreamEventsSheet({
  open,
  streamPath,
  subscribe,
  onClose,
}: {
  open: boolean;
  streamPath: string;
  subscribe: (
    onBatch: (events: WorkspaceStreamEvent[]) => void,
    afterOffset?: number,
  ) => Promise<StreamConnectionHandle>;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<WorkspaceStreamEvent[]>([]);
  // Formatted once per event AS BATCHES ARRIVE (never during render); the
  // map only grows alongside setEvents, so every render sees its labels.
  // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init -- empty-container allocation per render is the rule's concern; trivial here, and the ??= lazy idiom trips exhaustive-deps instead
  const timeLabels = useRef(new Map<number, string>());
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  // A fresh log every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    timeLabels.current.clear();
    setEvents([]);
  }, [open]);

  const onBatch = useCallback((batch: WorkspaceStreamEvent[]) => {
    for (const event of batch) {
      timeLabels.current.set(
        event.offset,
        event.createdAt === "" ? "" : eventTimeFormat.format(new Date(event.createdAt)),
      );
    }
    setEvents((current) => {
      // Replays and reconnects may overlap — the offset is the identity.
      const byOffset = new Map(current.map((event) => [event.offset, event]));
      for (const event of batch) byOffset.set(event.offset, event);
      return [...byOffset.values()].sort((a, b) => a.offset - b.offset);
    });
  }, []);
  const openConnection = useCallback(
    (deliver: (events: WorkspaceStreamEvent[]) => void, afterOffset: number) =>
      subscribe(deliver, Math.max(0, afterOffset)),
    [subscribe],
  );
  const { status } = useStreamConnection({ enabled: open, open: openConnection, onBatch });

  // A log tail: stay pinned to the newest event unless the user scrolled up.
  useEffect(() => {
    const node = scroller.current;
    if (node !== null && pinned.current) node.scrollTop = node.scrollHeight;
  }, [events]);

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetTitle className="sr-only">Stream events for {streamPath}</SheetTitle>
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 pr-12">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {streamPath}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
            {status === "live" ? `${events.length} events · live` : status}
          </span>
        </div>
        <div
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          }}
          className="min-h-0 flex-1 overflow-auto"
        >
          {events.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {status === "connecting"
                ? "Connecting…"
                : status === "live"
                  ? "No events yet."
                  : `Subscription failed: ${status}`}
            </p>
          ) : (
            events.map((event) => (
              <details key={event.offset} className="group border-b">
                <summary className="flex cursor-pointer items-center gap-2 px-4 py-1.5 text-xs hover:bg-muted/50">
                  <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                    {event.offset}
                  </span>
                  <span className="min-w-0 truncate font-mono">
                    {event.type.replace("events.iterate.com/", "")}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                    {timeLabels.current.get(event.offset) ?? ""}
                  </span>
                </summary>
                <pre className="max-h-64 overflow-auto bg-muted/40 px-4 py-2 text-[11px] whitespace-pre-wrap">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </details>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
