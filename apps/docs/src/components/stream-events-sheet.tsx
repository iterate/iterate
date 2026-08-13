import { useEffect, useRef, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@iterate-com/ui/components/sheet";
import type { WorkspaceStreamEvent } from "../lib/tasks-api.ts";

// One shared formatter: constructing a locale formatter per event per render
// is the slow path of toLocaleTimeString.
const eventTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * The workspace's platform stream, LIVE: `itx.streams.get(path).subscribe`
 * pushes durable history and then every new commit over the retained
 * callback — no polling. Chronological (latest at the end), pinned to the
 * bottom like a log tail. Chrome mirrors the apps/os stream sheet: a mono
 * stream path in the header and the sheet's own close affordance.
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
  ) => Promise<{ ping?(): Promise<boolean> | boolean; unsubscribe(): void }>;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<WorkspaceStreamEvent[]>([]);
  // Formatted once per event AS BATCHES ARRIVE (never during render); the
  // map only grows alongside setEvents, so every render sees its labels.
  // react-doctor-disable-next-line react-doctor/rerender-lazy-ref-init -- empty-container allocation per render is the rule's concern; trivial here, and the ??= lazy idiom trips exhaustive-deps instead
  const timeLabels = useRef(new Map<number, string>());
  const [status, setStatus] = useState<"connecting" | "live" | string>("connecting");
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  const lastOffset = useRef(-1);
  useEffect(() => {
    if (!open) return;
    timeLabels.current.clear();
    setEvents([]);
    setStatus("connecting");
    lastOffset.current = -1;
    let handle: { ping?(): Promise<boolean> | boolean; unsubscribe(): void } | null = null;
    let cancelled = false;
    let connecting = false;

    const onBatch = (batch: WorkspaceStreamEvent[]) => {
      if (cancelled) return;
      setStatus("live");
      // Events only ever arrive through batches, so the highest offset seen
      // across batches IS the merged list's tail — no need to read it back
      // out of the state updater (which must stay pure).
      for (const event of batch) {
        if (event.offset > lastOffset.current) lastOffset.current = event.offset;
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
    };

    const connect = (afterOffset: number) => {
      if (connecting) return; // single-flight — overlapping failures share one
      connecting = true;
      subscribe(onBatch, Math.max(0, afterOffset)).then(
        (opened) => {
          connecting = false;
          if (cancelled) {
            opened.unsubscribe();
            return;
          }
          handle = opened;
          // An open handle on an empty stream is live with zero events,
          // not stuck "Connecting…".
          setStatus("live");
        },
        (cause: unknown) => {
          connecting = false;
          if (!cancelled) setStatus(cause instanceof Error ? cause.message : String(cause));
        },
      );
    };
    connect(0);

    // The subscription rides the capnweb WS — a redial (any RPC failure
    // elsewhere disposes the session) silently drops it. Heartbeat the
    // handle and resubscribe from the last seen offset when it dies.
    let pinging = false;
    const heartbeat = setInterval(() => {
      void (async () => {
        if (cancelled || pinging) return; // a slow ping owns the verdict
        if (!handle) {
          // A failed (re)connect must keep retrying — a dead handle with no
          // retry would leave the sheet reading "live" forever.
          if (!connecting) {
            setStatus("reconnecting…");
            connect(lastOffset.current);
          }
          return;
        }
        pinging = true;
        try {
          if ((await handle.ping?.()) === false) throw new Error("subscription lapsed");
        } catch {
          if (cancelled) return;
          setStatus("reconnecting…");
          try {
            handle.unsubscribe();
          } catch {
            // the dead session is already gone
          }
          handle = null;
          connect(lastOffset.current);
        } finally {
          pinging = false;
        }
      })();
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      try {
        handle?.unsubscribe();
      } catch {
        // a session already torn down is fine
      }
    };
  }, [open, subscribe]);

  // A log tail: stay pinned to the newest event unless the user scrolled up.
  useEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
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
          {!events.length ? (
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
