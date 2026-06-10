// Live tail of a project's /itx audit stream: capabilities being provided,
// defined, revoked, disconnecting; contexts forking. The first instance of
// the canonical "filtered stream view" — friendly per-event-type renderers,
// raw mode shows the same events unfiltered (filtering is client-side by
// design). Rides useItx (suspends until connected — give it a Suspense
// boundary) with one kernel subscribe from "start": full replay + live tail.
// If the socket dies, useItx re-suspends and hands back a fresh handle; the
// effect re-subscribes from "start" again and dedupes the replay by offset.

import { useEffect, useState } from "react";
import type { Event as StreamEvent } from "@iterate-com/shared/streams/types";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { ITX_AUDIT_STREAM_PATH } from "~/itx/protocol.ts";
import { useItx } from "~/itx/use-itx.ts";

const MAX_BUFFERED_EVENTS = 500;

const FRIENDLY_RENDERERS: Record<string, (payload: Record<string, unknown>) => string> = {
  "events.iterate.com/itx/cap-provided": (p) => `capability "${p.name}" provided (live)`,
  "events.iterate.com/itx/cap-defined": (p) =>
    `capability "${p.name}" defined (${p.kind ?? "worker"})`,
  "events.iterate.com/itx/cap-revoked": (p) => `capability "${p.name}" revoked`,
  "events.iterate.com/itx/cap-disconnected": (p) => `capability "${p.name}" disconnected`,
  "events.iterate.com/itx/context-forked": (p) => `context forked: ${p.id ?? ""}`,
};

type TailStatus = "connecting" | "live" | "error";

export function ItxActivityTail({ projectId }: { projectId: string }) {
  const itx = useItx(projectId);
  const [raw, setRaw] = useState(false);
  const [events, setEvents] = useState<readonly StreamEvent[]>([]);
  const [status, setStatus] = useState<TailStatus>("connecting");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | null = null;
    setStatus("connecting");
    setError(undefined);
    itx.streams
      .get(ITX_AUDIT_STREAM_PATH)
      .subscribe(
        (batch) => {
          if (disposed) return;
          setEvents((previous) => {
            // Re-subscribing replays from "start"; offsets dedupe the overlap.
            const lastOffset = previous.at(-1)?.offset;
            const fresh = batch.events.filter(
              (event) => lastOffset === undefined || event.offset > lastOffset,
            );
            return fresh.length === 0
              ? previous
              : [...previous, ...fresh].slice(-MAX_BUFFERED_EVENTS);
          });
        },
        { afterOffset: "start" },
      )
      .then((subscription) => {
        const releaseSubscription = () =>
          void Promise.resolve(subscription.unsubscribe()).catch(() => {});
        if (disposed) {
          releaseSubscription();
          return;
        }
        release = releaseSubscription;
        setStatus("live");
      })
      .catch((subscribeError: unknown) => {
        if (disposed) return;
        setStatus("error");
        setError(subscribeError instanceof Error ? subscribeError.message : String(subscribeError));
      });
    return () => {
      disposed = true;
      release?.();
    };
  }, [itx]);

  const rows = raw
    ? events.map((event) => ({ event, text: null }))
    : events.flatMap((event) => {
        const render = FRIENDLY_RENDERERS[event.type];
        return render ? [{ event, text: render(event.payload as Record<string, unknown>) }] : [];
      });

  return (
    <section className="flex min-h-0 flex-col border-t">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            itx activity
          </h2>
          <Badge variant={status === "live" ? "default" : "secondary"}>{status}</Badge>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setRaw((value) => !value)}>
          {raw ? "Friendly" : "Raw"}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {status === "error" ? (
          <p className="py-2 font-mono text-xs text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            Nothing yet — provide a capability from the repl (itx.caps.provide) and watch it land
            here.
          </p>
        ) : (
          <ol className="space-y-1">
            {rows.slice(-100).map(({ event, text }) => (
              <li key={event.offset} className="font-mono text-xs">
                {text === null ? (
                  <RawEventRow event={event} />
                ) : (
                  <FriendlyEventRow event={event} text={text} />
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function FriendlyEventRow({ event, text }: { event: StreamEvent; text: string }) {
  return (
    <span className="flex gap-2 text-foreground">
      <span className="shrink-0 text-muted-foreground">#{event.offset}</span>
      <span className="truncate">{text}</span>
      <time className="ml-auto shrink-0 text-muted-foreground">
        {new Date(event.createdAt).toLocaleTimeString()}
      </time>
    </span>
  );
}

function RawEventRow({ event }: { event: StreamEvent }) {
  return (
    <details>
      <summary className="flex cursor-pointer gap-2 text-muted-foreground">
        <span className="shrink-0">#{event.offset}</span>
        <span className="truncate">{event.type}</span>
        <time className="ml-auto shrink-0">{new Date(event.createdAt).toLocaleTimeString()}</time>
      </summary>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words text-foreground">
        {JSON.stringify(event, null, 2)}
      </pre>
    </details>
  );
}
