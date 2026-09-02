// subscription-delivery.ts — THE ONE DELIVERY LOOP, run from the stream's post-commit hook: for every
// subscription row (a slice of the core reduced state), filter the batch by `consumes`, evaluate the
// target, and look at what came back:
//
//   • a FacetHandle or an RpcStubHandle (context/invoke-handle.ts) OWNS ITS PROGRESS — a facet keeps its
//     own checkpoint and gap-repairs from the log, a live client owns its offset and heals with read —
//     so it gets a PUSH of `(events, { after, through })`, one delivery chain per subscription;
//   • anything else — a Worker-Loader entrypoint, a sibling context, a remote — cannot own progress, so
//     THE STREAM KEEPS A CURSOR for it (`subscription-cursor:<name>` in this DO's kv, never in the log):
//     deliver from the cursor, the awaited call IS the ack, one bounded retry ladder (1s·2ⁿ, ≤30 min,
//     15 attempts, `retryable: false` halts at once) then a `subscription-delivery-halted` fact; an
//     operator's `subscription-delivery-resumed` un-halts and may seek. Retries ride the DO's own alarm
//     (facets have none, workerd#6810 — which is why this is kernel code and not a facet processor).
//
// Nothing here reads a "kind" off an event. The kind is the evaluated value's brand, minted by the
// built-in that produced it; a mount whose target names another capability classifies correctly because it evaluates to the same handle.
//
// Ranges: every delivery carries `{ after, through }` — the offset window it covers. Per subscription the
// loop remembers the last `through` it handed over (in memory), so a batch the filter skipped still
// rides inside the next delivered range and a push subscriber's chain stays contiguous. A cursor
// target additionally receives ephemerals when it is caught up (they ride the pushed batch; they are
// not in the log), never when it is behind.

import type { ItxExpression } from "../context/expression.ts";
import { callOn, walkSteps } from "../context/dispatch.ts";
import { FacetHandle, RpcStubHandle } from "../context/invoke-handle.ts";
import { errorCode, reportIssue } from "../lib/errors.ts";
import { createLogger } from "../lib/logs.ts";
import { withTimeout } from "../lib/timeout.ts";
import type { StreamEvent } from "./events.ts";
import { consumesEvent, type ScannedRange } from "./processor.ts";
import type { Subscription } from "./core-processor.ts";
import type { Stream } from "./stream.ts";

const log = createLogger("subscription-delivery");

/** THE cursor of a subscription the stream delivers at-least-once. Memory is the truth for this
 *  incarnation; kv (`subscription-cursor:<name>`) mirrors it at DURABLE boundaries only — an
 *  ephemeral-only batch advances memory and touches no storage (ephemerals are not in the log; after
 *  an eviction the kv cursor rewinds to the last durable boundary and durables are redelivered from
 *  there, which at-least-once allows). `resumeAppliedAtOffset` is the offset of the delivery-resumed
 *  fact this cursor already applied, so a resume is applied exactly once. */
type SubscriptionCursor = {
  confirmedOffset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  resumeAppliedAtOffset?: number;
};

type Deps = {
  kv: DurableObjectStorage["kv"];
  /** The stream: its rows (`coreReducedState.subscriptions`), its log, its durable mark, its alarm. */
  stream: Stream;
  /** Evaluate an itx expression through the context's own dispatch — a handle, a function, a value. */
  evaluate: (expression: ItxExpression) => Promise<unknown>;
  /** A delivery finished — the quiet clock restarts (the quiesce must not fire mid-traffic). */
  recordActivityForQuietClock: () => void;
};

export class SubscriptionDelivery {
  readonly #kv: DurableObjectStorage["kv"];
  readonly #stream: Stream;
  readonly #evaluate: Deps["evaluate"];
  readonly #recordActivityForQuietClock: () => void;
  /** Deliveries queue per subscription: a slow target never lets a later batch overtake an earlier one. */
  readonly #deliveryChainBySubscription = new Map<string, Promise<unknown>>();
  readonly #lastDeliveredThroughOffset = new Map<string, number>();
  /** The freshest pushed batch per cursor subscription — how ephemerals reach a caught-up cursor
   *  target (the log has no ephemerals; the push does). Latest wins; a stale one is ignored. */
  readonly #pushedEventBatches = new Map<
    string,
    { events: StreamEvent[]; after: number; through: number }
  >();
  readonly #cursorDeliveryRunning = new Set<string>();
  readonly #cursors = new Map<string, SubscriptionCursor>();

  constructor(deps: Deps) {
    this.#kv = deps.kv;
    this.#stream = deps.stream;
    this.#evaluate = deps.evaluate;
    this.#recordActivityForQuietClock = deps.recordActivityForQuietClock;
    // The kv cursors seed memory once, here — after this, memory is the one truth.
    for (const [key, cursor] of this.#kv.list<SubscriptionCursor>({
      prefix: "subscription-cursor:",
    }))
      this.#cursors.set(key.slice("subscription-cursor:".length), cursor);
  }

  /** The post-commit hook: one pass over the rows. Fire-and-forget from append's view. */
  onCommit(freshEvents: StreamEvent[], afterOffset: number, nextOffset: number): void {
    const rows = this.#stream.coreReducedState.subscriptions;
    for (const event of freshEvents) {
      switch (event.type) {
        case "events.iterate.com/stream/subscription-delivery-resumed": {
          // An operator's resume is itself the wake: deliver that name NOW, whatever its `consumes`
          // says (the resumed fact is rarely a type the subscriber asked for, and a halted row has no
          // retry armed — without this it would wait for the next matching commit or the quiet clock).
          const name = (event.payload as { name: string }).name;
          if (rows[name])
            void this.#deliverFromCursor(name).catch((error) =>
              reportIssue("subscription-delivery.resume", error, { name }),
            );
          break;
        }
        case "events.iterate.com/stream/subscription-configured": {
          // A configured row REPLACES (a `null` target REMOVES — the row is gone by now, so only the
          // forget below runs): everything remembered about the old row under this name belonged to
          // the old target. The new target is evaluated ONCE right away, whatever its `consumes`
          // says — a processor's facet is materialized at enable time and catches up from the log, so
          // `itx.facets.get(name)` answers before its first consumed event, and a target whose head
          // cannot be evaluated is reported here once instead of once per commit. That catch-up is the
          // HEAD of this name's delivery chain, so the first push queues behind it: one materialization.
          const name = (event.payload as { name: string }).name;
          this.#forgetSubscription(name);
          const row = rows[name];
          if (row)
            this.#deliveryChainBySubscription.set(
              name,
              (async () => {
                const { head } = await this.#evaluateTargetHead(row.target);
                if (
                  head instanceof FacetHandle &&
                  this.#stream.coreReducedState.subscriptions[name]
                )
                  await head.invoke([["catchUpFromLog"]]);
              })().catch((error) => {
                // NO_FACET here is a disable that landed during the load — nothing to report.
                if (errorCode(error) !== "NO_FACET")
                  reportIssue("subscription-delivery.configured", error, { name });
              }),
            );
          break;
        }
      }
    }
    for (const [name, row] of Object.entries(rows)) {
      const events = freshEvents.filter((event) => consumesEvent(row.consumes, event));
      // A batch the filter skipped is NOT handed over — the watermark stays put and the skipped span
      // rides inside the NEXT delivered range (the subscriber's chain stays contiguous).
      if (events.length === 0) continue;
      const after = this.#lastDeliveredThroughOffset.get(name) ?? afterOffset;
      this.#lastDeliveredThroughOffset.set(name, nextOffset);
      this.#pushedEventBatches.set(name, { events, after, through: nextOffset });
      const chain = (this.#deliveryChainBySubscription.get(name) ?? Promise.resolve()).then(() =>
        this.#deliverEventBatch(name, row, events, { after, through: nextOffset }),
      );
      this.#deliveryChainBySubscription.set(
        name,
        chain.catch(() => undefined),
      );
    }
  }

  /** The alarm's half: every cursor subscription — a due retry, or one an eviction left mid-delivery.
   *  Cheap when nothing is due: one read each, empty when caught up. */
  async deliverEveryCursorSubscription(): Promise<void> {
    await Promise.all(
      [...this.#cursors.keys()].map((name) =>
        this.#deliverFromCursor(name).catch((error) =>
          reportIssue("subscription-delivery.cursor", error, { name }),
        ),
      ),
    );
  }

  /** The cursor of a subscription the stream delivers at-least-once — absent for a push target. */
  cursor(name: string): SubscriptionCursor | undefined {
    return this.#cursors.get(name);
  }

  #forgetSubscription(name: string): void {
    this.#cursors.delete(name);
    this.#kv.delete(`subscription-cursor:${name}`);
    this.#deliveryChainBySubscription.delete(name);
    this.#lastDeliveredThroughOffset.delete(name);
    this.#pushedEventBatches.delete(name);
  }

  /** Memory always; kv only when `writeKv` (a durable boundary moved, a ladder step, a halt, a resume
   *  — never an ephemeral-only advance). */
  #adoptCursor(name: string, cursor: SubscriptionCursor, writeKv: boolean): void {
    this.#cursors.set(name, cursor);
    if (writeKv) this.#kv.put(`subscription-cursor:${name}`, cursor);
  }

  // ── one batch, one subscription: evaluate, look at the value, push or cursor ──

  async #deliverEventBatch(
    name: string,
    row: Subscription,
    events: StreamEvent[],
    range: ScannedRange,
  ): Promise<void> {
    try {
      // The row must still exist on BOTH sides of the (async) evaluation: evaluating a processor's
      // load chain materializes its facet, so a push racing `disableProcessor` must not call — and
      // must not resurrect what `facets.delete` just removed.
      if (!this.#stream.coreReducedState.subscriptions[name]) return;
      const { head, call } = await this.#evaluateTargetHead(row.target);
      if (!this.#stream.coreReducedState.subscriptions[name]) return;
      if (head instanceof RpcStubHandle) {
        // A LIVE CLIENT owns its offset: fire-and-forget — the pager socket is the queue, its order is
        // the order, and a stalled client blocks nothing but itself. RPC_STUB_OFFLINE is the benign
        // heal-by-pull case (the stub is not there right now; the mount stays, the client re-lends);
        // anything else is a real drop worth a line — the subscriber sees the range gap and heals.
        this.#pushedEventBatches.delete(name);
        void call([events, range]).catch((error) => {
          if (errorCode(error) !== "RPC_STUB_OFFLINE")
            log.warn("push delivery dropped", { event: "delivery.push.dropped", name, error });
        });
        return;
      }
      if (head instanceof FacetHandle) {
        // A FACET owns its checkpoint: push, AWAITED, so this facet's batches stay in order and the
        // quiesce never aborts it mid-reduce. The DO's facet watchdog (#invokeFacet, 60 s) bounds a
        // hung facet; its own gap repair covers a dropped push.
        this.#pushedEventBatches.delete(name);
        await call([events, range]);
        return;
      }
      // CANNOT own progress: the stream keeps the cursor. The pushed batch was remembered in onCommit;
      // the cursor delivery takes it when contiguous, else it pages the log.
      await this.#deliverFromCursor(name, call);
    } catch (error) {
      // NO_FACET is a disable that landed under an in-flight push — the row is gone too.
      if (errorCode(error) !== "NO_FACET")
        reportIssue("subscription-delivery.deliver", error, { name });
    } finally {
      this.#recordActivityForQuietClock();
    }
  }

  /** Evaluate a target's HEAD (everything but a trailing method name) and return the value plus the
   *  one call to make on it. A target ending in a call step names the callee itself (a bare lent
   *  callback: `itx.rpcStubs.get('k')`); a trailing property step names the method to call on it
   *  (`…get('presence').processEventBatch`). */
  async #evaluateTargetHead(
    target: ItxExpression,
  ): Promise<{ head: unknown; call: (args: unknown[]) => Promise<unknown> }> {
    const last = target.at(-1);
    const method = typeof last === "string" && target.length > 1 ? last : undefined;
    const head = await this.#evaluate(method ? target.slice(0, -1) : target);
    const call = async (args: unknown[]): Promise<unknown> =>
      method
        ? (
            await walkSteps(
              { value: head, receiver: undefined },
              [[method, ...args]],
              `subscription target ${JSON.stringify(method)}`,
            )
          ).value
        : callOn(head, undefined, args);
    return { head, call };
  }

  // ── the stream-kept cursor: at-least-once, from the cursor row, the awaited call is the ack ──

  /** `call` is the already-evaluated target when the caller just classified it (onCommit's push); the
   *  alarm and a resume evaluate it here. One delivery loop per name at a time — the loop drains. */
  async #deliverFromCursor(
    name: string,
    call?: (args: unknown[]) => Promise<unknown>,
  ): Promise<void> {
    if (this.#cursorDeliveryRunning.has(name)) return;
    this.#cursorDeliveryRunning.add(name);
    try {
      for (;;) {
        const row = this.#stream.coreReducedState.subscriptions[name];
        if (!row) return this.#forgetSubscription(name);
        let cursor = this.#cursors.get(name);
        if (!cursor) {
          // A subscription's FIRST cursor: born at its configuration offset ("now"), in memory only —
          // the first durable delivery writes it.
          cursor = { confirmedOffset: row.configuredAtOffset, attempt: 0 };
          this.#adoptCursor(name, cursor, false);
        }
        // A delivery-resumed not yet applied: seek (if asked) and clear the ladder.
        if (row.resumed && row.resumed.atOffset !== cursor.resumeAppliedAtOffset) {
          cursor = {
            // A seek is clamped to the durable mark: past it, the cursor would sit beyond every event
            // until the stream caught up — "resume from the end" is what such a seek means.
            confirmedOffset: Math.min(
              row.resumed.afterOffset ?? cursor.confirmedOffset,
              this.#stream.highestDurableOffset(),
            ),
            attempt: 0,
            resumeAppliedAtOffset: row.resumed.atOffset,
          };
          this.#adoptCursor(name, cursor, true);
        }
        if (row.halted) return;
        if (cursor.nextAttemptAtMs !== undefined && Date.now() < cursor.nextAttemptAtMs) {
          this.#stream.armNoLaterThan(cursor.nextAttemptAtMs);
          return;
        }
        // The batch: the pushed one when contiguous (ephemerals ride it); else a page of the log — read
        // only UP TO the pushed batch's start, so that once the durables before it are delivered the
        // cursor IS contiguous with it and takes it, ephemerals included. A pushed batch the cursor has
        // already passed is stale and forgotten.
        let pushedEventBatch = this.#pushedEventBatches.get(name);
        if (pushedEventBatch && pushedEventBatch.after < cursor.confirmedOffset) {
          this.#pushedEventBatches.delete(name);
          pushedEventBatch = undefined;
        }
        let eventBatch: { events: StreamEvent[]; through: number };
        if (pushedEventBatch && pushedEventBatch.after === cursor.confirmedOffset) {
          this.#pushedEventBatches.delete(name);
          eventBatch = { events: pushedEventBatch.events, through: pushedEventBatch.through };
        } else {
          const page = this.#stream.read(cursor.confirmedOffset, 100);
          const ceiling = pushedEventBatch
            ? Math.min(page.scannedThroughOffset, pushedEventBatch.after)
            : page.scannedThroughOffset;
          if (ceiling <= cursor.confirmedOffset) return; // caught up
          eventBatch = {
            events: page.events.filter(
              (event) => event.offset <= ceiling && consumesEvent(row.consumes, event),
            ),
            through: ceiling,
          };
        }
        const range: ScannedRange = { after: cursor.confirmedOffset, through: eventBatch.through };
        const durable = eventBatch.events.some((event) => !event.ephemeral);
        if (eventBatch.events.length === 0) {
          this.#adoptCursor(name, { ...cursor, confirmedOffset: range.through }, true); // a log page: durable ground
          continue;
        }
        try {
          call ??= (await this.#evaluateTargetHead(row.target)).call;
          await withTimeout(call([eventBatch.events, range]), 20_000, `subscription "${name}"`);
          // Removed or replaced while the call was in flight? Its progress belonged to the old row.
          if (!this.#cursors.has(name)) continue;
          this.#adoptCursor(
            name,
            {
              confirmedOffset: range.through,
              attempt: 0,
              resumeAppliedAtOffset: cursor.resumeAppliedAtOffset,
            },
            durable, // an ephemeral-only batch never touches storage
          );
          this.#recordActivityForQuietClock();
        } catch (error) {
          if (!this.#cursors.has(name)) continue;
          // A delivery-resumed that landed DURING this attempt is not yet applied: loop back and apply
          // it instead of arming the old ladder or, worse, appending a halt on top of the operator's resume.
          const latest = this.#stream.coreReducedState.subscriptions[name];
          if (latest?.resumed && latest.resumed.atOffset !== cursor.resumeAppliedAtOffset) continue;
          const attempt = cursor.attempt + 1;
          const message = error instanceof Error ? error.message : String(error);
          // Honor stamped flags over an invented taxonomy: `retryable: false` (workerd stamps these;
          // providers may too) will never succeed — halt now, not in half an hour.
          const neverRetryable = (error as { retryable?: unknown } | null)?.retryable === false;
          if (neverRetryable || attempt >= 15) {
            this.#adoptCursor(name, { ...cursor, attempt: 0 }, true);
            await this.#stream.append({
              type: "events.iterate.com/stream/subscription-delivery-halted",
              payload: {
                name,
                afterOffset: cursor.confirmedOffset,
                attempts: attempt,
                error: message,
              },
            });
            return;
          }
          const backoff =
            Math.min(1000 * 2 ** (attempt - 1), 1_800_000) * (0.8 + Math.random() * 0.4);
          const nextAttemptAtMs = Date.now() + Math.round(backoff);
          this.#adoptCursor(name, { ...cursor, attempt, nextAttemptAtMs }, true);
          this.#stream.armNoLaterThan(nextAttemptAtMs);
          return;
        }
      }
    } finally {
      this.#cursorDeliveryRunning.delete(name);
    }
  }
}
