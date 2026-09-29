// cause.ts — THE LOOP GUARD, explained here and nowhere else; user code never sees it until it saves
// it. Every event and every call carries its CAUSE: the chain of reactions it belongs to (when and
// where that chain began) and how many hand-offs deep in it it is. The platform stamps it on events
// and calls; the SDK's doors carry it through loaded code unread (iterate src/cause.ts). Three
// guarantees rest on it:
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

import { codedError, errorCode } from "iterate/lib";

/** The chain a piece of work belongs to and how deep in it the work is — as an event stores it
 *  (`source.cause`), and as a call carries it, with what only the call needs. */
export type Cause = {
  /** Where and when the chain began, time-ordered: `<ISO time> with <origin> ~<nonce>`. */
  chain: string;
  /** Hand-offs since the chain began: 0 for a person's call, one more per delivery or script. */
  depth: number;
  /** The contexts the call has crossed so far (guarantee 2). */
  hops?: number;
  /** The delivery the code runs for (`<row>:<path>@<offset>`), the same on every attempt: what
   *  keys the writes it makes (guarantee 3). Never a mark's: only a call carries it. */
  writeKey?: string;
};

/** The deepest a chain acts at: past it, code may read but not act. */
export const LOOP_DEPTH_LIMIT = 8;
/** The most contexts one call crosses. */
const MAX_CONTEXT_HOPS = 16;
/** OUR MARK on what we send (egress, webhooks, secret dispatch): the cause as JSON. Unsigned:
 *  forging it can only make the forger's own request deeper. The SDK's doors read it by name. */
export const ITERATE_CAUSE_HEADER = "iterate-cause";
/** The same mark on mail we send, beside `Auto-Submitted: auto-generated` (a mail header of ours
 *  must be an `X-` one). */
export const ITERATE_CAUSE_MAIL_HEADER = "X-Iterate-Cause";

/** A new chain, at depth 0, beginning now `with` its origin: the kind of thing that began it ("a
 *  call", "inbound mail", "a request to <host>"), never who — no path, no address. */
export function newChain(origin: string): Cause {
  const nonce = Math.random().toString(36).slice(2, 7);
  return {
    chain: `${new Date().toISOString()} with ${origin.slice(0, 200)} ~${nonce}`,
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

/** THE ONE +1: code run because of `events` runs one hand-off deeper than the deepest of them, in
 *  its chain, with no hops. An event with no cause counts as a chain's first. */
export function causeOfDelivery(events: readonly { source?: { cause?: Cause } }[]): Cause {
  const deepest =
    deepestCause(events.map((event) => event.source?.cause)) ??
    newChain("an event that names no cause");
  return { chain: deepest.chain, depth: deepest.depth + 1 };
}

/** A cause as an event stores it: the chain and the depth, never what only a call needs. */
export function storedCause({ chain, depth }: Cause): Cause {
  return { chain, depth };
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
  const refusal = (error as { data?: Refusal } | undefined)?.data;
  // a hop past MAX_CONTEXT_HOPS is no depth refusal: it carries no chain to record
  if (errorCode(error) !== "LOOP_LIMIT" || !refusal?.chain || refusal.recorded) return;
  record({ chain: refusal.chain, depth: refusal.depth }, (error as Error).message);
  refusal.recorded = true;
}

/** What marks a fetch's answer as a refusal past the limit (unavailable.ts
 *  `expressionFetchErrorAnswer`), so the SDK's `fetch` and `itx.fetch` throw it as one again. */
export const LOOP_LIMIT_HEADER = "iterate-loop-limit";

/** THE HOP COUNT: the call `cause` rides crosses one more context — a `cd`, a located call, a parent
 *  link, a request re-entering the platform — refused past MAX_CONTEXT_HOPS. A plain failure, not the
 *  loop's end: rules that lead into each other are the owner's to fix, and a delivery through them
 *  is tried again, and lands once they are. */
export function crossingOneMore(cause: Cause, into: string): Cause {
  const hops = (cause.hops ?? 0) + 1;
  if (hops > MAX_CONTEXT_HOPS)
    throw new Error(
      `${into} refused: one call crossed more than ${MAX_CONTEXT_HOPS} contexts in the chain that began ${cause.chain} — rules, rows or requests that lead back into each other`,
    );
  return { ...cause, hops };
}

/** A cause as ITERATE_CAUSE_HEADER carries it: JSON, ASCII only (a header is bytes). */
export function causeHeader(cause: Cause): string {
  return JSON.stringify({ chain: cause.chain, depth: cause.depth, hops: cause.hops ?? 0 }).replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** `request` carrying `cause` as our mark: how a Request hands it to the SDK's request door. */
export function requestCausedBy(request: Request, cause: Cause): Request {
  const headers = new Headers(request.headers);
  headers.set(ITERATE_CAUSE_HEADER, causeHeader(cause));
  return new Request(request, { headers });
}

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
  const { chain, depth, hops, writeKey } = (fields ?? {}) as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  const text = (s: unknown): s is string => typeof s === "string" && s.length <= 512;
  if (!text(chain) || !count(depth) || !count(hops || 0)) return undefined;
  return {
    chain,
    depth,
    hops: (hops as number | undefined) || 0,
    ...(!mark && text(writeKey) && { writeKey }),
  };
}

/** The SDK's carrier of the running cause in this isolate (iterate src/cause.ts), by the name it
 *  shares it under. */
const sdkCarrier = () =>
  (globalThis as Record<symbol, SdkCarrier | undefined>)[Symbol.for("iterate.cause")];
type SdkCarrier = { run<T>(cause: unknown, code: () => T): T; current(): unknown };

/** The cause the SDK's door runs this isolate's current code under: what the platform's own facets —
 *  a repo, a project — act under. */
export function runningCause(): Cause | undefined {
  return parseCause(sdkCarrier()?.current());
}

/** Run the platform's own facet code under `cause`, as the SDK's door runs what it is handed. */
export function runningUnder<T>(cause: Cause | undefined, work: () => T): T {
  const carrier = sdkCarrier();
  return carrier ? carrier.run(cause, work) : work();
}
