// cause.ts — THE LOOP GUARD, explained here and nowhere else; user code never sees it until it saves
// it. Every event and every call carries its CAUSE: the chain of reactions it belongs to (when and
// where that chain began) and how many hand-offs deep in it it is. The platform stamps it on events
// and calls; the SDK carries it through loaded code unread, from a host's `callWithCause` or a
// Request's mark (iterate src/cause.ts). Three guarantees rest on it:
//
// 1. BOUNDED CAUSAL DEPTH. A person's call, an outside request and inbound mail without our mark
//    begin a chain at depth 0. Depth goes up by one only where code runs BECAUSE of an event or of
//    other code — a delivery (`causeOfDelivery`), a script run — and everything else keeps it: a
//    receipt, a retry, a revive, a schedule's firing, an agent's own turns. What we send carries our
//    mark (ITERATE_CAUSE_HEADER), and what comes back with it resumes at its depth. Past
//    LOOP_DEPTH_LIMIT code may still read, but every act — an append, a send, egress, a commit,
//    waking a sleeping context, a birth — is refused LOOP_LIMIT naming where the chain began
//    (`refuseActPastLimit`), and the context records one `itx/loop-limit` fact per chain.
// 2. BOUNDED SYNCHRONOUS ROUTING. One call crosses at most MAX_CONTEXT_HOPS contexts — `cd`s,
//    located calls, parent links, a request re-entering the platform (`crossingOneMore`). Hops ride
//    the call, never an event: every hand-off starts again at none.
// 3. STABLE RETRY EFFECTS. What code writes while it handles a delivery — an append without a key
//    of its own, a mail — is keyed by that delivery (`Cause.writeKey`), where it lands and what it
//    is: the same on every attempt, so a retry never repeats what an attempt before it did, and the
//    same write twice in one delivery lands once.
//
// The same stamp says WHY anything happened: the chain names where it began (a request's with its
// Cloudflare ray, which joins Cloudflare's own request log), and `parent` the event whose handling
// wrote it, so any event walks back to its origin one step at a time.

import { codedError, errorCode, ITERATE_CAUSE_HEADER } from "iterate/lib";
import { z } from "zod";

/** The chain a piece of work belongs to and how deep in it the work is — as an event stores it
 *  (`source.cause`), and as a call carries it, with what only the call needs. */
export type Cause = {
  /** Where and when the chain began, time-ordered: `<ISO time> with <origin> ~<nonce>`. */
  chain: string;
  /** Hand-offs since the chain began: 0 for a person's call, one more per delivery or script. */
  depth: number;
  /** The event whose handling this work runs for, `<path>@<offset>`: the step before, on every
   *  event the work writes. None where a person's call or an outside request began the work. */
  parent?: string;
  /** The contexts the call has crossed so far (guarantee 2). */
  hops?: number;
  /** The delivery the code runs for (`<row>:<path>@<offset>`), the same on every attempt: what
   *  keys the writes it makes (guarantee 3). Never a mark's: only a call carries it. */
  writeKey?: string;
  /** The signed token of who a script runs for (on-behalf-of.ts), from the run's runner: what an
   *  append verifies into `source.onBehalfOf`. Never a mark's, never stored: only a call carries
   *  it, and a delivery's cause starts without it. */
  onBehalfOf?: string;
};

/** The deepest a chain acts at: past it, code may read but not act. */
export const LOOP_DEPTH_LIMIT = 8;
/** The most contexts one call crosses. */
const MAX_CONTEXT_HOPS = 16;
/** A new chain, at depth 0, beginning now `with` its origin: the kind of thing that began it ("a
 *  call", "inbound mail", "a request to <host> (ray <cf-ray>)"), never who — no path, no address;
 *  a ray is Cloudflare's opaque id for the request, which its logs are searched by. Printable ASCII
 *  only, so our mark (iterate/lib `ITERATE_CAUSE_HEADER`, unsigned: forging it can only make the
 *  forger's own request deeper) is plain JSON on any header. */
export function newChain(origin: string): Cause {
  const nonce = Math.random().toString(36).slice(2, 7);
  return {
    chain: `${new Date().toISOString()} with ${origin.slice(0, 200).replace(/[^\x20-\x7e]/g, "?")} ~${nonce}`,
    depth: 0,
  };
}

/** The deepest of `causes` (the first of equals), or none. */
export function deepestCause(causes: readonly (Cause | undefined)[]): Cause | undefined {
  let deepest: Cause | undefined;
  for (const cause of causes)
    if (cause && (!deepest || cause.depth > deepest.depth)) deepest = cause;
  return deepest;
}

/** THE ONE +1: code run because of `events` runs one hand-off deeper than the deepest of them (the
 *  first of equals), in its chain, with no hops, and with that event as its parent — or, when what
 *  it runs for is a call and no event (a script's run), that call's own parent. An event with no
 *  cause counts as a chain's first. */
export function causeOfDelivery(
  events: readonly { path?: string; offset?: number; source?: { cause?: Cause } }[],
): Cause {
  let deepest = events[0];
  for (const event of events)
    if ((event.source?.cause?.depth ?? -1) > (deepest?.source?.cause?.depth ?? -1)) deepest = event;
  const cause = deepest?.source?.cause || newChain("an event that names no cause");
  // a committed event's offset is 1 or more
  const parent =
    deepest?.path && deepest.offset ? `${deepest.path}@${deepest.offset}` : cause.parent;
  return { chain: cause.chain, depth: cause.depth + 1, parent };
}

/** A cause as an event stores it: the chain, the depth and the parent, never what only a call
 *  needs — and no `parent` key at all without one, so an event reads the same live as stored. */
export function storedCause({ chain, depth, parent }: Cause): Cause {
  return parent ? { chain, depth, parent } : { chain, depth };
}

/** THE REFUSAL of an act past the limit — an append, a send, egress, a commit, waking a sleeping
 *  context, a birth — and THE ONE ERROR a loop meets: coded LOOP_LIMIT, never retried, naming where
 *  its chain began, and carrying the chain its fact is recorded under (`recordRefusal`). */
export function refuseActPastLimit(cause: Cause | undefined, act: string): void {
  if (cause && cause.depth > LOOP_DEPTH_LIMIT)
    throw codedError(
      "LOOP_LIMIT",
      `${act} refused: it is ${cause.depth} steps into a chain of reactions that began ${cause.chain}${cause.writeKey ? `, handed on by the row "${cause.writeKey.split(":")[0]}"` : ""}. Past ${LOOP_DEPTH_LIMIT} steps, code that reacts to other code may read but not act — something here reacts to its own output`,
      { chain: cause.chain, depth: cause.depth } satisfies Refusal,
    );
}

type Refusal = { chain: string; depth: number; recorded?: true };

/** THE ONE REFUSAL HANDLER, wherever the platform meets an act's refusal first — the append, the
 *  call or the fetch it refused, a delivery's settlement: the chain's one `itx/loop-limit` fact is
 *  recorded there (`record`) and the refusal marked so, before anything treats it as the loop's
 *  end; one met again on its way out is recorded no more. Any other error is left alone. */
export function recordRefusal(
  error: unknown,
  record: (cause: Cause, message: string) => void,
): void {
  if (errorCode(error) !== "LOOP_LIMIT") return;
  // A LOOP_LIMIT carries the Refusal `refuseActPastLimit` put on it, marked here in place, so the
  // same error met again is recorded no more; the SDK's (a 508 its fetch met) was recorded where it
  // was met, and carries no chain.
  const refusal = (error as { data?: Refusal }).data;
  if (!refusal?.chain || refusal.recorded) return;
  record(
    { chain: refusal.chain, depth: refusal.depth },
    error instanceof Error ? error.message : String(error),
  );
  refusal.recorded = true;
}

/** THE HOP COUNT: the call `cause` rides crosses `contexts` more — a `cd`, a located call, a parent
 *  link, a request re-entering the platform — refused past MAX_CONTEXT_HOPS. A plain failure, not the
 *  loop's end: rules that lead into each other are the owner's to fix, and a delivery through them
 *  is tried again, and lands once they are. */
export function crossingOneMore(cause: Cause, into: string, contexts = 1): Cause {
  const hops = (cause.hops ?? 0) + contexts;
  if (hops > MAX_CONTEXT_HOPS)
    throw new Error(
      `${into} refused: one call crossed more than ${MAX_CONTEXT_HOPS} contexts in the chain that began ${cause.chain} — rules, rows or requests that lead back into each other`,
    );
  return { ...cause, hops };
}

/** A cause as ITERATE_CAUSE_HEADER carries it: JSON, ASCII (a header is bytes; `newChain`), so a
 *  parent in any other characters stays behind. */
export function causeHeader({ chain, depth, hops, parent }: Cause): string {
  return JSON.stringify({
    chain,
    depth,
    hops: hops ?? 0,
    ...(parent && PRINTABLE_ASCII.test(parent) && { parent }),
  });
}

/** `request` carrying `cause` as our mark: how a Request hands it to the SDK host serving it. */
export function requestCausedBy(request: Request, cause: Cause): Request {
  const headers = new Headers(request.headers);
  headers.set(ITERATE_CAUSE_HEADER, causeHeader(cause));
  return new Request(request, { headers });
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** A count a cause carries: a safe whole number, never below 0. */
const CauseCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A cause as anyone may write it (`parseCause`). A chain the platform mints is printable ASCII
 *  (`newChain`), so any other is forged; a malformed parent or write key is dropped alone. */
const WrittenCause = z.object({
  chain: z.string().max(512).regex(PRINTABLE_ASCII),
  depth: CauseCount,
  parent: z.string().max(512).optional().catch(undefined),
  hops: CauseCount.nullish(),
  writeKey: z.string().max(512).optional().catch(undefined),
  onBehalfOf: z.string().max(4096).optional().catch(undefined),
});

/** `value` as a cause — loaded code's word for its own over RPC, or a mark's text, the JSON
 *  ITERATE_CAUSE_HEADER carries — or none when it is not one: either is anyone's to write, so a
 *  malformed one is no cause at all, a malformed write key is none, and a mark keys no writes. */
export function parseCause(value: unknown): Cause | undefined {
  const mark = typeof value === "string";
  let fields = value;
  if (mark)
    try {
      fields = JSON.parse(value);
    } catch {
      return undefined;
    }
  const written = WrittenCause.safeParse(fields);
  if (!written.success) return undefined;
  const { chain, depth, parent, hops, writeKey, onBehalfOf } = written.data;
  return {
    chain,
    depth,
    parent,
    hops: hops || 0,
    ...(!mark && writeKey && { writeKey }),
    ...(!mark && onBehalfOf && { onBehalfOf }),
  };
}

/** The SDK's carrier of the running cause in this isolate (iterate src/cause.ts), by the name it
 *  shares it under. */
const sdkCarrier = () =>
  (globalThis as Record<symbol, SdkCarrier | undefined>)[Symbol.for("iterate.cause")];
type SdkCarrier = { run<T>(cause: unknown, code: () => T): T; current(): unknown };

/** The cause the SDK's carrier runs this isolate's current code under: what the platform's own
 *  facets — a repo, a project — act under. */
export function runningCause(): Cause | undefined {
  return parseCause(sdkCarrier()?.current());
}

/** Run the platform's own facet code under `cause`, as the SDK's `callWithCause` runs what it is
 *  handed. */
export function runningUnder<T>(cause: Cause | undefined, work: () => T): T {
  const carrier = sdkCarrier();
  return carrier ? carrier.run(cause, work) : work();
}
