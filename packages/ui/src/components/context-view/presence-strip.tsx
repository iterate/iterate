// Who is here: the people who acted on the context, newest first (from the log's stamps), and how
// many live rpc stubs are lent to it right now. One line, text — no badges.
import { cn } from "../../lib/utils.ts";
import type { ContextViewPresence } from "./types.tsx";

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
