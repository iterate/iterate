// stream/provenance.ts — WHO WROTE AN EVENT, and whom a reader listens to. A project is one trust
// boundary: inside it anyone may append anything anywhere, and nothing can forge where an event came
// from. The platform replaces every event's `source` WHOLE as it commits (apps/os caller.ts
// `stampCaller`): which context's code or session wrote it (`origin`), which member (`principal`),
// and whether the platform itself vouches for it (`platform`). Readers decide:
//
//   trusted at X  =  source.platform  ·  source.principal (a member)  ·  source.origin is X or above X
//
// A processor acts on the events `admits` passes: trusted ones, plus the types its contract opens to
// anyone (`trust: { [type]: "anyone" }`). The engine applies it before every reduce (processor.ts);
// the platform's delivery loop applies it for raw readers (a live client, a config worker). Signing
// later is a property of the stamp, not of this rule: no reader changes when it comes.
import type { Principal } from "../principal.ts";
import type { StreamEvent } from "./processor.ts";

/** THE PROVENANCE STAMP on a committed event — the platform writes all of it; a writer's own
 *  `source` is dropped whole. */
export type EventSource = {
  /** The context whose code or session wrote the event: where the call started (the platform's
   *  `Caller.path`, stamped at the first hop), else the context appended to. */
  origin: string;
  /** A member's session wrote it: the verified principal. */
  principal?: Principal;
  /** The connection the principal acted through. */
  grant?: string;
  /** The platform itself vouches for the event: a platform verb, or the context's own records. */
  platform?: true;
  /** A schedule fired it: the definition's receipt (read the `schedule-set` for who defined it). */
  schedule?: { key: string; scheduledAtOffset: number; at: string };
};

/** Whether `path` is `ancestor` or beneath it. */
export const isAtOrBeneath = (path: string, ancestor: string): boolean =>
  path === ancestor || path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);

/** THE ONE PREDICATE: an event written with `source` is trusted at the context `here` when the
 *  platform vouches for it, a member wrote it, or code at `here` or above it did. */
export const trusts = (here: string, source: EventSource): boolean =>
  source.platform === true || !!source.principal || isAtOrBeneath(here, source.origin);

/** Whom a reader listens to for one event type: `"anyone"` in the project, `"trusted"` writers
 *  (the default), the `"platform"` alone, or its own rule over the stamp. */
export type TrustRule =
  | "anyone"
  | "trusted"
  | "platform"
  | ((source: EventSource, event: StreamEvent) => boolean);

/** A certificate its subject wrote about itself: the event names a `path`, and the code at that path
 *  wrote it — an entity's birth or death cross-posted to `/`, which is below none of its readers. */
export const certifiesItself = (source: EventSource, event: StreamEvent): boolean =>
  source.origin === (event.payload as { path?: unknown } | undefined)?.path;

/** The platform's own entities certify themselves on `/` (their facets cross-post there): the
 *  default for every reader, so a project processor and a config worker alike follow them. */
const FIRST_PARTY_TRUST: Readonly<Record<string, TrustRule>> = {
  "events.iterate.com/repo/created": certifiesItself,
  "events.iterate.com/repo/deleted": certifiesItself,
  "events.iterate.com/repo/commit-completed": certifiesItself,
  "events.iterate.com/workspace/created": certifiesItself,
  "events.iterate.com/workspace/deleted": certifiesItself,
};

/** Whether a reader acts on `event`: its `trust` rule for the type (`"*"` for every type it does not
 *  name), else the platform's first-party rule, else `"trusted"`. A core `itx/*` event is always
 *  admitted: the context refused a misplaced one when it was written. An event written before
 *  stamps (no origin) is read as it was. */
export function admits(
  event: Pick<StreamEvent, "type" | "path" | "source" | "payload">,
  trust?: Readonly<Record<string, TrustRule>>,
): boolean {
  if (event.type.startsWith("events.iterate.com/itx/")) return true;
  const rule = trust?.[event.type] ?? FIRST_PARTY_TRUST[event.type] ?? trust?.["*"] ?? "trusted";
  if (rule === "anyone") return true;
  if (rule === "platform") return event.source?.platform === true;
  const source = event.source;
  if (!source?.origin) return true;
  return rule === "trusted" ? trusts(event.path, source) : rule(source, event as StreamEvent);
}
