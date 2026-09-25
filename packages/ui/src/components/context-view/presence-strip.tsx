// Who is here: the people who acted on the context, newest first (from the log's stamps), and how
// many live rpc stubs are lent to it right now. One line, text — no badges. And how busy it is:
// `EventRate`, the strip's live metric (the old header's was a latency sparkline).
import { useEffect, useState } from "react";
import { cn } from "cn";
import type { ContextViewEvent, ContextViewPresence } from "./types.tsx";

/** ` · 12/min`: the events of the last minute, from the tail back (the log is sorted), re-counted
 *  every few seconds while there are any so the rate falls when the log goes quiet; nothing when
 *  the minute was quiet. */
export function EventRate({ events }: { events: readonly ContextViewEvent[] }) {
  const [now, setNow] = useState(() => Date.now());
  let count = 0;
  for (let at = events.length - 1; at >= 0; at--) {
    if (now - Date.parse(events[at]!.createdAt) > 60_000) break;
    count += 1;
  }
  useEffect(() => {
    if (count === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [count]);
  // a new event restarts the minute from now
  useEffect(() => setNow(Date.now()), [events]);
  if (count === 0) return null;
  return <span title="Events in the last minute">{` · ${String(count)}/min`}</span>;
}

export function PresenceStrip({
  actors,
  rpcStubs,
  className,
  onPick,
}: {
  actors: readonly ContextViewPresence[];
  rpcStubs: readonly string[];
  className?: string;
  /** Narrow the stream to one actor (again clears). */
  onPick?: (actor: string | undefined) => void;
}) {
  const shown = actors.slice(0, 5);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {shown.map((who) => (
        <button
          key={who.actor}
          type="button"
          className="truncate hover:text-foreground"
          title={`${who.actor}${who.grant ? ` via ${who.grant}` : ""} · last ${new Date(who.lastSeenAt).toLocaleString()}`}
          onClick={() => onPick?.(who.actor)}
        >
          {who.email || who.actor}
        </button>
      ))}
      {actors.length > shown.length ? <span>+{actors.length - shown.length}</span> : null}
      {rpcStubs.length > 0 ? (
        <span title={rpcStubs.join(", ")}>
          {rpcStubs.length} live {rpcStubs.length === 1 ? "stub" : "stubs"}
        </span>
      ) : null}
    </div>
  );
}
