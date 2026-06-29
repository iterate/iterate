// Live tail of the project context's own stream (the project root stream —
// the only authority for its capability table): capabilities being provided,
// revoked, disconnecting; script executions. The first instance of the canonical
// "filtered stream view" — friendly per-event-type renderers, raw mode shows
// the same events unfiltered (filtering is client-side by design). Rides useItx (suspends until connected — give it a Suspense
// boundary) with one kernel subscribe from "start": full replay + live tail.
// If the socket dies, useItx re-suspends and hands back a fresh handle; the
// effect re-subscribes from "start" again and dedupes the replay by offset.

import { useState } from "react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import type { StreamEvent } from "~/domains/streams/engine/shared/event.ts";
import { useItxEffect } from "~/itx/itx-react.tsx";

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

export function ItxActivityTail(_props: { projectId: string }) {
  // The project layout route wraps this in <ItxProvider projectId={slug}>, so
  // useItxEffect's injected handle is THIS project's shared socket — the projectId
  // prop is no longer needed to address the connection.
  const [raw, setRaw] = useState(false);
  const [events, setEvents] = useState<readonly StreamEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [error, setError] = useState<string>();

  useItxEffect(async (itx) => {
    setStatus("connecting");
    setError(undefined);
    try {
      const subscription = await itx.streams.get(PROJECT_CONTEXT_PATH).subscribe({
        replayAfterOffset: 0,
        processEventBatch: (batch) => {
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
      });
      setStatus("live");
      return () => subscription.unsubscribe();
    } catch (subscribeError: unknown) {
      setStatus("error");
      setError(subscribeError instanceof Error ? subscribeError.message : String(subscribeError));
    }
  }, []);

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
