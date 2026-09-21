// The platform's own events, as sentences — what every context's log carries whatever the app:
// the stream's lifecycle, its subscriptions, live state, the context's script runs. The view lays
// an app's renderers over these (the app's win), so a page never shows `stream/woken {"incarnation"…}`.
import type { EventRenderers } from "./types.tsx";

const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const record = (value: unknown): Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]"
    ? (value as Record<string, unknown>) // explained: the toString brand is the plain-object check
    : {};

/** A muted mono span for an id, a path or a name inside a sentence. */
const mono = (text: string) => (
  <span className="font-mono text-xs text-muted-foreground">{text}</span>
);
/** The platform's housekeeping reads quieter than what people and apps did. */
const quiet = (text: string) => <span className="text-muted-foreground">{text}</span>;

export const coreEventRenderers: EventRenderers = {
  "events.iterate.com/stream/created": () => quiet("The context was born"),
  "events.iterate.com/stream/woken": (e) => {
    const p = record(e.payload);
    return quiet(`Woke (${str(p.reason, "?")}, incarnation ${String(p.incarnation)})`);
  },
  "events.iterate.com/stream/paused": (e) => quiet(`Paused ${str(record(e.payload).reason)}`),
  "events.iterate.com/stream/resumed": () => quiet("Resumed"),
  "events.iterate.com/stream/subscription-configured": (e) => {
    const p = record(e.payload);
    const consumes = Array.isArray(p.consumes) ? p.consumes.map(String) : [];
    return (
      <span className="text-muted-foreground">
        Subscription {mono(str(p.name))} configured
        {consumes.length > 0 ? <> · consumes {mono(consumes.join(", "))}</> : null}
      </span>
    );
  },
  "events.iterate.com/live-state/changed": () => quiet("Live state changed"),
  "events.iterate.com/context/run-requested": (e) => {
    const code = str(record(e.payload).code);
    return <>Ran a script {mono((code.split("\n")[0] || "").slice(0, 100))}</>;
  },
  "events.iterate.com/context/run-settled": (e) => {
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
