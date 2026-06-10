// Live tail of a project's /itx audit stream: capabilities being provided,
// defined, revoked, disconnecting; contexts forking. The first instance of
// the canonical "filtered stream view" — friendly per-event-type renderers,
// raw mode shows the same events unfiltered (filtering is client-side by
// design), live over the tab's single itx WebSocket via useStreamEvents.

import { useState } from "react";
import type { Event as StreamEvent } from "@iterate-com/shared/streams/types";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { ITX_AUDIT_STREAM_PATH } from "~/itx/protocol.ts";
import { useStreamEvents } from "~/itx/react/index.ts";

const FRIENDLY_RENDERERS: Record<string, (payload: Record<string, unknown>) => string> = {
  "events.iterate.com/itx/cap-provided": (p) => `capability "${p.name}" provided (live)`,
  "events.iterate.com/itx/cap-defined": (p) =>
    `capability "${p.name}" defined (${p.kind ?? "worker"})`,
  "events.iterate.com/itx/cap-revoked": (p) => `capability "${p.name}" revoked`,
  "events.iterate.com/itx/cap-disconnected": (p) => `capability "${p.name}" disconnected`,
  "events.iterate.com/itx/context-forked": (p) => `context forked: ${p.id ?? ""}`,
};

export function ItxActivityTail({ projectId }: { projectId: string }) {
  const [raw, setRaw] = useState(false);
  const tail = useStreamEvents({ project: projectId, streamPath: ITX_AUDIT_STREAM_PATH });
  const visible = raw
    ? tail.events
    : tail.events.filter((event) => event.type in FRIENDLY_RENDERERS);

  return (
    <section className="flex min-h-0 flex-col border-t">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            itx activity
          </h2>
          <Badge variant={tail.status === "live" ? "default" : "secondary"}>{tail.status}</Badge>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setRaw((value) => !value)}>
          {raw ? "Friendly" : "Raw"}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {tail.status === "error" ? (
          <p className="py-2 font-mono text-xs text-red-700">{tail.error}</p>
        ) : visible.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            Nothing yet — provide a capability from the repl (itx.caps.provide) and watch it land
            here.
          </p>
        ) : (
          <ol className="space-y-1">
            {visible.slice(-100).map((event) => (
              <li key={event.offset} className="font-mono text-xs">
                {raw ? <RawEventRow event={event} /> : <FriendlyEventRow event={event} />}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function FriendlyEventRow({ event }: { event: StreamEvent }) {
  const render = FRIENDLY_RENDERERS[event.type];
  return (
    <span className="flex gap-2 text-slate-700">
      <span className="shrink-0 text-slate-400">#{event.offset}</span>
      <span className="truncate">
        {render ? render(event.payload as Record<string, unknown>) : event.type}
      </span>
      <time className="ml-auto shrink-0 text-slate-400">
        {new Date(event.createdAt).toLocaleTimeString()}
      </time>
    </span>
  );
}

function RawEventRow({ event }: { event: StreamEvent }) {
  return (
    <details>
      <summary className="flex cursor-pointer gap-2 text-slate-600">
        <span className="shrink-0 text-slate-400">#{event.offset}</span>
        <span className="truncate">{event.type}</span>
        <time className="ml-auto shrink-0 text-slate-400">
          {new Date(event.createdAt).toLocaleTimeString()}
        </time>
      </summary>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words text-slate-800">
        {JSON.stringify(event, null, 2)}
      </pre>
    </details>
  );
}
