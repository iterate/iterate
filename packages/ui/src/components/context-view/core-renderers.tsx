// The platform's own events, as sentences — what every context's log carries whatever the app:
// the stream's lifecycle, its subscriptions, live state, the context's script runs. The view lays
// an app's renderers over these (the app's win), so a page never shows `itx/woken {"incarnation"…}`.
import { ContextPathText } from "./context-path.tsx";
import { mono, record, str } from "./renderer-helpers.tsx";
import type { EventInspectors, EventRenderers } from "./types.tsx";

/** The platform's housekeeping reads quieter than what people and apps did. */
const quiet = (text: string) => <span className="text-muted-foreground">{text}</span>;

/** The platform's HOUSEKEEPING — what the stream does to keep itself running (waking, wiring a
 *  client's subscription, a live-state tick, a scheduled append), never what anyone did. Pretty mode
 *  folds a run of these into one quiet row; the birth, a pause and a script run are not housekeeping. */
export function isHousekeeping(type: string): boolean {
  return (
    type === "events.iterate.com/itx/woken" ||
    type.startsWith("events.iterate.com/itx/subscription-") ||
    type.startsWith("events.iterate.com/itx/schedule-") ||
    type === "events.iterate.com/itx/live-state-changed"
  );
}

/** One line for a folded run of housekeeping: `woke, subscription ×8, live state` — a kind once,
 *  its count only when it repeats. */
export function housekeepingSummary(types: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const type of types) {
    const label =
      type === "events.iterate.com/itx/woken"
        ? "woke"
        : type.startsWith("events.iterate.com/itx/subscription-")
          ? "subscription"
          : type === "events.iterate.com/itx/live-state-changed"
            ? "live state"
            : "scheduled append";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, n]) => (n > 1 ? `${label} ×${String(n)}` : label))
    .join(", ");
}

/** The inspector's rich bodies for the platform's events: a script run's code, its result. */
export const coreEventInspectors: EventInspectors = {
  "events.iterate.com/itx/run-requested": (e) => (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">
      {str(record(e.payload).code)}
    </pre>
  ),
  "events.iterate.com/itx/run-settled": (e) => {
    const s = record(record(e.payload).settlement);
    return s.status === "succeeded" ? (
      <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">
        {JSON.stringify(s.result ?? null, null, 2)}
      </pre>
    ) : (
      <p data-type="error" className="text-sm text-destructive">
        {str(s.failureKind)}: {str(s.error)}
      </p>
    );
  },
};

export const coreEventRenderers: EventRenderers = {
  "events.iterate.com/itx/created": () => quiet("The context was born"),
  "events.iterate.com/itx/woken": (e) => {
    const p = record(e.payload);
    // the context's Durable Object started again (an eviction, a deploy): purple, as the old feed
    // drew it, and nothing more
    return (
      <span className="text-purple-700">
        Woke · {str(p.reason, "?")} · incarnation {String(p.incarnation)}
      </span>
    );
  },
  "events.iterate.com/itx/paused": (e) => quiet(`Paused ${str(record(e.payload).reason)}`),
  "events.iterate.com/itx/resumed": () => quiet("Resumed"),
  "events.iterate.com/itx/child-created": (e) => (
    <span className="text-muted-foreground">
      Child context <ContextPathText path={str(record(e.payload).childPath)} /> created
    </span>
  ),
  "events.iterate.com/itx/subscription-configured": (e) => {
    const p = record(e.payload);
    const consumes = Array.isArray(p.consumes) ? p.consumes.map(String) : [];
    return (
      <span className="text-muted-foreground">
        Subscription {mono(str(p.name))} configured
        {consumes.length > 0 ? <> · consumes {mono(consumes.join(", "))}</> : null}
      </span>
    );
  },
  "events.iterate.com/itx/live-state-changed": () => quiet("Live state changed"),
  "events.iterate.com/itx/run-requested": (e) => {
    const code = str(record(e.payload).code);
    return <>Ran a script {mono((code.split("\n")[0] || "").slice(0, 100))}</>;
  },
  "events.iterate.com/itx/run-settled": (e) => {
    const p = record(e.payload);
    const s = record(p.settlement);
    return s.status === "succeeded" ? (
      <>
        Script {mono(`#${String(p.requestOffset)}`)} returned{" "}
        {mono(JSON.stringify(s.result ?? null).slice(0, 100))}
      </>
    ) : (
      <>
        Script {mono(`#${String(p.requestOffset)}`)} failed ({str(s.failureKind)}):{" "}
        {str(s.error).slice(0, 140)}
      </>
    );
  },
};
