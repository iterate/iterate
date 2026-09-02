// subscription-delivery.ts — THE ONE DELIVERY LOOP, run from the stream's post-commit hook: for every
// subscription (subscriptions.ts), filter the batch by `consumes`, evaluate the target, and ask the
// value what it is:
//
//   • a FacetHandle or an RpcStubHandle (context/invoke-handle.ts) OWNS ITS PROGRESS — a facet keeps its
//     own checkpoint and gap-repairs from the log, a live client owns its offset and heals with read —
//     so it gets a fire-and-forget PUSH of `(events, { after, through })`, serialized per subscription;
//   • anything else — a Worker-Loader entrypoint, a sibling context, a remote — cannot own progress, so
//     THE STREAM KEEPS A CURSOR for it (a kv row per subscription, effect-side truth like a facet's
//     checkpoint, never in the log): deliver from the cursor, the awaited call IS the ack, one bounded
//     retry ladder (1s·2ⁿ, ≤30 min, 15 attempts, `retryable: false` halts at once) then a
//     `subscription-delivery-halted` fact; an operator's `subscription-delivery-resumed` un-halts and
//     may seek. Retries ride the DO's own alarm (facets have none, workerd#6810 — which is why this
//     is kernel code and not a facet processor).
//
// Nothing here reads a "kind" off an event. The kind is the evaluated value's brand, minted by the
// built-in that produced it; an alias classifies correctly because it evaluates to the same handle.
//
// Ranges: every delivery carries `{ after, through }` — the offset window it covers. Per subscription the
// loop remembers the last `through` it handed over (in memory), so a batch the filter skipped still
// rides inside the next delivered range and a push subscriber's chain stays contiguous. A cursor
// target additionally receives ephemerals when it is caught up (they ride the pushed batch; they are
// not in the log), never when it is behind.

import type { Expression } from "../context/expression.ts";
import { invokePath } from "../context/dispatch.ts";
import { FacetHandle, InvokeHandle, RpcStubHandle } from "../context/invoke-handle.ts";
import { errorCode, reportIssue } from "../lib/errors.ts";
import { createLogger } from "../lib/logs.ts";
import type { StreamEvent, StreamEventInput } from "./events.ts";
import { consumesEvent, type ScannedRange } from "./processor.ts";
import type { Subscription } from "./core-processor.ts";

const log = createLogger("subscription-delivery");

/** THE cursor of a subscription the stream delivers at-least-once. IN MEMORY for this incarnation;
 *  written to kv (`subscription-cursor:<name>`) ONLY when a delivered batch contained a durable event —
 *  an ephemeral-only batch advances the memory cursor and touches no storage (ephemerals are not in
 *  the log; after an eviction the kv cursor rewinds to the last durable boundary and the pump
 *  redelivers durables from there, which at-least-once allows). `resumedAt` is the offset of the
 *  delivery-resumed fact already applied — an in-flight delivery that started before a resume
 *  compares it and yields (the resume's cursor wins; a redelivery is exactly what a replay asks). */
export type SubscriptionCursor = {
  confirmedOffset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  resumedAt?: number;
};

const CURSOR_PREFIX = "subscription-cursor:";
const MAX_ATTEMPTS = 15;
const DELIVERY_TIMEOUT_MS = 20_000;

type Deps = {
  kv: {
    get<T>(key: string): T | undefined;
    put(key: string, value: unknown): void;
    delete(key: string): void;
    list<T>(options: { prefix: string }): Iterable<[string, T]>;
  };
  /** The subscription rows by name, current as of the last commit (the core reduce's slice). */
  subscriptions: () => Readonly<Record<string, Subscription>>;
  read: (
    afterOffset: number,
    limit: number,
  ) => { events: StreamEvent[]; scannedThroughOffset: number };
  /** The DURABLE high-water mark — a resume's seek is clamped to it (a seek past it would park the
   *  cursor beyond every event until the stream caught up: a dead row; and a cursor is PERSISTED, so
   *  it may never name an offset a later incarnation could hand to a durable). */
  head: () => number;
  /** Append a fact onto the stream (the halted event). */
  append: (event: StreamEventInput) => Promise<unknown>;
  /** Evaluate an itx expression through the context's own dispatch — a handle, a function, a value. */
  evaluate: (expression: Expression) => Promise<unknown>;
  /** The DO's one alarm, min-merged (stream/stream.ts armNoLaterThan). */
  armNoLaterThan: (atMs: number) => void;
  /** A delivery finished — the quiet clock restarts (the quiesce must not fire mid-traffic). */
  onActivity: () => void;
  now: () => number;
};

export class SubscriptionDelivery {
  readonly #deps: Deps;
  /** Per subscription: the push chain (a slow target must not let a later batch overtake an earlier
   *  one) and the last range end handed over (a skipped batch rides inside the next range). */
  readonly #pushes = new Map<string, Promise<unknown>>();
  readonly #deliveredThrough = new Map<string, number>();
  /** The freshest pushed batch per cursor subscription — the way ephemerals reach a caught-up cursor
   *  target (the log has no ephemerals; the push does). Latest wins; a stale one is ignored. */
  readonly #pushedEventBatches = new Map<
    string,
    { events: StreamEvent[]; after: number; through: number }
  >();
  readonly #pumping = new Set<string>();
  /** The cursor truth for this incarnation; kv is its durable shadow, written at durable boundaries. */
  readonly #cursors = new Map<string, SubscriptionCursor>();
  #inFlight = 0;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** Deliveries (pushes and cursor calls) still running — the quiesce respects it. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** The post-commit hook: one pass over the table. Fire-and-forget from append's view. */
  onCommit(freshEvents: StreamEvent[], scannedAfterOffset: number, nextOffset: number): void {
    const table = this.#deps.subscriptions();
    for (const event of freshEvents) {
      // A removed subscription takes its cursor row and its in-memory traces with it.
      if (event.type === "events.iterate.com/stream/subscription-removed")
        this.forget((event.payload as { name: string }).name);
      // An operator's resume is itself the wake: pump that name NOW, whatever its `consumes` says
      // (the resumed fact is rarely one of the types the subscriber asked for, and a halted row has
      // no retry armed — without this it would wait for the next matching commit or the quiet clock).
      if (event.type === "events.iterate.com/stream/subscription-delivery-resumed") {
        const name = (event.payload as { name: string }).name;
        if (table[name])
          void this.#pump(name).catch((error) =>
            reportIssue("subscription-delivery.resume-pump", error, { name }),
          );
      }
      // A configured row REPLACES: whatever the loop remembered about the old row under this name
      // (a stream-kept cursor, a pushed batch, a watermark) belonged to the old target, so it goes.
      // Then the new target is evaluated ONCE right away, whatever its `consumes` says: a processor's
      // facet is MATERIALIZED at enable time (`catchUpFromLog` on the handle — so `itx.facets.get(name)`
      // answers before its first consumed event), and a target whose head cannot be evaluated is
      // reported here, once, instead of once per commit. The wake is the HEAD of this name's push
      // chain, so the first push (often this very event) queues behind it: one materialization,
      // one source evaluation — never two loads racing each other.
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        const name = (event.payload as { name: string }).name;
        this.forget(name);
        const sub = table[name];
        if (sub)
          this.#pushes.set(
            name,
            this.#resolve(sub.target)
              .then(({ head }) =>
                head instanceof FacetHandle && this.#deps.subscriptions()[name]
                  ? invokePath(head, ["catchUpFromLog"], [], `facet "${name}"`)
                  : undefined,
              )
              .catch((error) => {
                // NO_FACET here is a disable that landed during the load — nothing to report.
                if (errorCode(error) !== "NO_FACET")
                  reportIssue("subscription-delivery.configured", error, { name });
              }),
          );
      }
    }
    for (const [name, sub] of Object.entries(table)) {
      const events = freshEvents.filter((event) => consumesEvent(sub.consumes, event));
      // A batch the filter skipped is NOT handed over — so the watermark stays put and the skipped
      // span rides inside the NEXT delivered range (the subscriber's chain stays contiguous).
      if (events.length === 0) continue;
      const after = this.#deliveredThrough.get(name) ?? scannedAfterOffset;
      this.#deliveredThrough.set(name, nextOffset);
      this.#pushedEventBatches.set(name, { events, after, through: nextOffset });
      const chain = (this.#pushes.get(name) ?? Promise.resolve()).then(() =>
        this.#dispatch(name, sub, events, { after, through: nextOffset }),
      );
      this.#pushes.set(
        name,
        chain.catch(() => undefined),
      );
    }
  }

  /** The alarm's half: pump every cursor subscription (a due retry, or one left behind by an
   *  eviction mid-delivery). Cheap when nothing is due — one read each, empty when caught up. */
  async pumpAll(): Promise<void> {
    const table = this.#deps.subscriptions();
    const names = new Set<string>(this.#cursors.keys());
    for (const [key] of this.#deps.kv.list<SubscriptionCursor>({ prefix: CURSOR_PREFIX }))
      names.add(key.slice(CURSOR_PREFIX.length));
    await Promise.allSettled(
      [...names].map((name) => {
        const sub = table[name];
        if (!sub) {
          this.forget(name);
          return undefined;
        }
        return this.#pump(name);
      }),
    );
  }

  /** The cursor of a subscription the stream delivers at-least-once — absent for a push target. */
  cursor(name: string): SubscriptionCursor | undefined {
    return this.#cursors.get(name) ?? this.#deps.kv.get<SubscriptionCursor>(CURSOR_PREFIX + name);
  }

  /** Drop everything remembered about a subscription (its removal, or a name that no longer exists). */
  forget(name: string): void {
    this.#cursors.delete(name);
    this.#deps.kv.delete(CURSOR_PREFIX + name);
    this.#pushes.delete(name);
    this.#deliveredThrough.delete(name);
    this.#pushedEventBatches.delete(name);
  }

  /** Adopt a cursor: memory always; kv only when `durable` (a durable boundary moved, a ladder step,
   *  a halt, a resume — never an ephemeral-only advance). */
  #save(name: string, row: SubscriptionCursor, durable: boolean): void {
    this.#cursors.set(name, row);
    if (durable) this.#deps.kv.put(CURSOR_PREFIX + name, row);
  }

  // ── one batch, one subscription: evaluate, look at the value, push or cursor ──

  async #dispatch(name: string, sub: Subscription, events: StreamEvent[], range: ScannedRange) {
    this.#inFlight++;
    try {
      // The row must still exist on BOTH sides of the (async) evaluation: evaluating a processor's
      // load chain materializes its facet, so a push racing `disableProcessor` must not call — and
      // must not resurrect what `facets.delete` just removed.
      const alive = () => this.#deps.subscriptions()[name] !== undefined;
      if (!alive()) return;
      const { head, call } = await this.#resolve(sub.target);
      if (!alive()) return;
      if (head instanceof RpcStubHandle) {
        // A LIVE CLIENT owns its offset: fire-and-forget — the pager socket is the queue, its order is
        // the order, and a stalled client blocks nothing but itself. CONNECTION_OFFLINE is the benign
        // heal-by-pull case (the stub is not there right now; the mount stays, the client re-parks);
        // anything else is a real drop worth a line — the subscriber sees the range gap and heals.
        this.#pushedEventBatches.delete(name); // only a stream-kept cursor ever reads it
        void call([events, range]).catch((error) => {
          if (errorCode(error) !== "CONNECTION_OFFLINE")
            log.warn("push delivery dropped", { event: "delivery.push.dropped", name, error });
        });
        return;
      }
      if (head instanceof FacetHandle) {
        // A FACET owns its checkpoint: push, AWAITED — so this facet's batches stay in order (a slow
        // materialization must not let a later batch overtake an earlier one) and the quiesce never
        // aborts it mid-reduce — under the same watchdog as a cursor delivery (a hung facet must not
        // hold this chain, and this actor, forever). Its own gap repair covers a dropped push.
        this.#pushedEventBatches.delete(name);
        await withTimeout(call([events, range]), DELIVERY_TIMEOUT_MS, name);
        return;
      }
      // CANNOT own progress: the stream keeps the cursor. The pushed batch is remembered (onCommit);
      // the pump delivers from the cursor, taking the pushed batch when contiguous.
      await this.#pump(name);
    } catch (error) {
      // NO_FACET is a disable that landed under an in-flight push — the row is gone too.
      if (errorCode(error) !== "NO_FACET")
        reportIssue("subscription-delivery.dispatch", error, { name });
    } finally {
      this.#inFlight--;
      this.#deps.onActivity();
    }
  }

  /** Evaluate a target's HEAD (everything but a trailing method name) and return the value plus the
   *  one call to make on it. A target ending in a call step names the callee itself (a bare parked
   *  callback: `itx.rpcStubs.get('k')`); a trailing property step names the method to call on it
   *  (`…get('presence').processEventBatch`). */
  async #resolve(
    target: Expression,
  ): Promise<{ head: unknown; call: (args: unknown[]) => Promise<unknown> }> {
    const last = target.at(-1);
    const method = typeof last === "string" && target.length > 1 ? last : undefined;
    const head = await this.#deps.evaluate(method ? target.slice(0, -1) : target);
    const call = async (args: unknown[]): Promise<unknown> => {
      if (method)
        return invokePath(head, [method], args, `subscription target ${JSON.stringify(method)}`);
      if (head instanceof InvokeHandle) return head.applyRoot(args);
      if (typeof head === "function") return (head as (...a: unknown[]) => unknown)(...args);
      throw new Error(
        "subscription target is not callable — name a method on it, or target a callable",
      );
    };
    return { head, call };
  }

  // ── the stream-kept cursor: at-least-once, from the kv row, the awaited call is the ack ──

  async #pump(name: string): Promise<void> {
    if (this.#pumping.has(name)) return; // one in flight per subscription; the loop below drains
    this.#pumping.add(name);
    this.#inFlight++;
    try {
      for (;;) {
        const current = this.#deps.subscriptions()[name];
        if (!current) return this.forget(name);
        let row = this.cursor(name);
        if (!row) {
          // A subscription's FIRST cursor: born at its configuration offset ("now"), in memory only —
          // the first durable delivery writes it. Adopted before the call so the generation compare
          // below has a row to compare against.
          row = { confirmedOffset: current.configuredAtOffset, attempt: 0 };
          this.#save(name, row, false);
        }
        // A delivery-resumed not yet applied: seek (if asked) and clear the ladder. Its offset is the
        // generation an in-flight delivery compares against before it writes.
        if (current.resumed && current.resumed.atOffset !== row.resumedAt) {
          row = {
            // A seek is clamped to the head: past it, the row would sit beyond every event until the
            // stream caught up — "resume from the end" is what such a seek means.
            confirmedOffset: Math.min(
              current.resumed.afterOffset ?? row.confirmedOffset,
              this.#deps.head(),
            ),
            attempt: 0,
            resumedAt: current.resumed.atOffset,
          };
          this.#save(name, row, true);
        }
        if (current.halted) return;
        if (row.nextAttemptAtMs !== undefined && this.#deps.now() < row.nextAttemptAtMs) {
          this.#deps.armNoLaterThan(row.nextAttemptAtMs);
          return;
        }
        // The batch: the pushed one when contiguous (ephemerals ride it); else a page of the log — read
        // only UP TO the pushed batch's start, so that once the durables before it are delivered the
        // row IS contiguous with it and takes it, ephemerals included. A pushed batch the cursor has
        // already passed is stale and forgotten.
        let pushedEventBatch = this.#pushedEventBatches.get(name);
        if (pushedEventBatch && pushedEventBatch.after < row.confirmedOffset) {
          this.#pushedEventBatches.delete(name);
          pushedEventBatch = undefined;
        }
        let eventBatch: { events: StreamEvent[]; through: number };
        if (pushedEventBatch && pushedEventBatch.after === row.confirmedOffset) {
          this.#pushedEventBatches.delete(name);
          eventBatch = { events: pushedEventBatch.events, through: pushedEventBatch.through };
        } else {
          const page = this.#deps.read(row.confirmedOffset, 100);
          const ceiling = pushedEventBatch
            ? Math.min(page.scannedThroughOffset, pushedEventBatch.after)
            : page.scannedThroughOffset;
          if (ceiling <= row.confirmedOffset) return; // caught up
          eventBatch = {
            events: page.events.filter(
              (event) => event.offset <= ceiling && consumesEvent(current.consumes, event),
            ),
            through: ceiling,
          };
        }
        const range: ScannedRange = { after: row.confirmedOffset, through: eventBatch.through };
        const durable = eventBatch.events.some((event) => !event.ephemeral);
        if (eventBatch.events.length === 0) {
          this.#save(name, { ...row, confirmedOffset: range.through }, true); // a log page: durable ground
          continue;
        }
        try {
          const { call } = await this.#resolve(current.target);
          await withTimeout(call([eventBatch.events, range]), DELIVERY_TIMEOUT_MS, name);
          if (!this.#sameGeneration(name, row)) continue; // a resume (or removal) landed mid-delivery
          this.#save(
            name,
            { confirmedOffset: range.through, attempt: 0, resumedAt: row.resumedAt },
            durable, // an ephemeral-only batch never touches storage
          );
          this.#deps.onActivity();
        } catch (error) {
          if (!this.#sameGeneration(name, row)) continue;
          // A delivery-resumed that landed DURING this attempt is not yet applied (the row's
          // generation is unchanged — nobody else pumps this name): loop back and apply it instead of
          // arming the old ladder or, worse, appending a halt on top of the operator's resume.
          const latest = this.#deps.subscriptions()[name];
          if (latest?.resumed && latest.resumed.atOffset !== row.resumedAt) continue;
          const attempt = row.attempt + 1;
          const message = error instanceof Error ? error.message : String(error);
          // Honor stamped flags over an invented taxonomy: `retryable: false` (workerd stamps these;
          // providers may too) will never succeed — halt now, not in half an hour.
          const neverRetryable =
            typeof error === "object" &&
            error !== null &&
            (error as { retryable?: unknown }).retryable === false;
          if (neverRetryable || attempt >= MAX_ATTEMPTS) {
            this.#save(name, { ...row, attempt: 0 }, true);
            await this.#deps.append({
              type: "events.iterate.com/stream/subscription-delivery-halted",
              payload: {
                name,
                afterOffset: row.confirmedOffset,
                attempts: attempt,
                error: message,
              },
            });
            return;
          }
          const backoff =
            Math.min(1000 * 2 ** (attempt - 1), 1_800_000) * (0.8 + Math.random() * 0.4);
          const nextAttemptAtMs = this.#deps.now() + Math.round(backoff);
          this.#save(name, { ...row, attempt, nextAttemptAtMs }, true);
          this.#deps.armNoLaterThan(nextAttemptAtMs);
          return;
        }
      }
    } finally {
      this.#pumping.delete(name);
      this.#inFlight--;
    }
  }

  /** The row we started from is still the row (same resume generation, not removed)? */
  #sameGeneration(name: string, started: SubscriptionCursor): boolean {
    const latestCursor = this.cursor(name);
    return latestCursor !== undefined && latestCursor.resumedAt === started.resumedAt;
  }
}

/** The delivery watchdog, CLEARED on the happy path — a leaked timer per delivery would pin the DO. */
async function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`subscription "${name}": delivery timed out after ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
