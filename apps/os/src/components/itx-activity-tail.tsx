// Live tail of the project context's own stream (the project root stream —
// the only authority for its capability table): capabilities being provided,
// revoked, disconnecting; script executions. The first instance of the canonical
// "filtered stream view" — friendly per-event-type renderers, raw mode shows
// the same events unfiltered (filtering is client-side by design). Rides useItx (suspends until connected — give it a Suspense
// boundary) with one kernel subscribe from "start": full replay + live tail.
// If the socket dies, useItx re-suspends and hands back a fresh handle; the
// effect re-subscribes from "start" again and dedupes the replay by offset.

import { useEffect, useState } from "react";
import type { Event as StreamEvent } from "@iterate-com/shared/streams/types";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { useItx } from "~/itx/use-itx.ts";

const MAX_BUFFERED_EVENTS = 500;

/** The project context's stream path — the project root (coordinates.ts). */
const PROJECT_CONTEXT_PATH = "/";

const capabilityName = (p: Record<string, unknown>) =>
  Array.isArray(p.path) ? p.path.join(".") : String(p.name ?? "");

const FRIENDLY_RENDERERS: Record<string, (payload: Record<string, unknown>) => string> = {
  "events.iterate.com/itx/capability-provided": (p) =>
    `capability "${capabilityName(p)}" provided (${p.kind ?? "rpc"})`,
  "events.iterate.com/itx/capability-revoked": (p) => `capability "${capabilityName(p)}" revoked`,
  "events.iterate.com/itx/capability-disconnected": (p) =>
    `capability "${capabilityName(p)}" disconnected`,
  "events.iterate.com/itx/context-created": (p) => `context created: ${p.name ?? ""}`,
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
      .get(PROJECT_CONTEXT_PATH)
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
        // Release BOTH ends on unmount: unsubscribe() tears down the server-side
        // subscription, and disposing the subscription stub frees our RPC import
        // of it. On a long-lived (pooled) socket an undisposed stub would
        // accumulate in the session's import table for the life of the tab.
        const releaseSubscription = () => {
          void Promise.resolve(subscription.unsubscribe()).catch(() => {});
          (subscription as Partial<Disposable>)[Symbol.dispose]?.();
        };
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
            Nothing yet — provide a capability from the repl (itx.provideCapability) and watch it
            land here.
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
