// subscription-delivery.ts — THE ONE DELIVERY LOOP, run from the stream's post-commit hook: for every
// subscription row, filter the batch by `consumes`, evaluate the target, and look at what came back:
//
//   • a FacetHandle or an RpcStubHandle (context/expression.ts) OWNS ITS PROGRESS — a facet keeps
//     its own checkpoint and gap-repairs from the log, a live client owns its offset and heals with
//     read — so it gets a PUSH of `(events, { after, through })`, one delivery chain per subscription;
//   • anything else cannot own progress, so THE STREAM KEEPS A CURSOR for it (a `subscription_cursors`
//     row, never in the log): the awaited call IS the ack, one bounded retry ladder (1s·2ⁿ, ≤30 min,
//     15 attempts, `retryable: false` halts at once) then a `subscription-delivery-halted` fact; an
//     operator's `subscription-delivery-resumed` un-halts and may seek. Retries ride the DO's own
//     alarm (facets have none, workerd#6810 — which is why this is kernel code, not a facet processor).
//
// AT-LEAST-ONCE survives an eviction because the alarm's pass re-derives its obligations from the
// ROWS and the log — never from the cursor table, which a first delivery has not written yet — and
// because this lane ARMS THE ALARM ITSELF whenever a delivery is owed: when a batch is queued for a
// row it does not know as a push row, and before every awaited call, for the call's own watchdog
// horizon. Die mid-call and the alarm survives to come back.
//
// Nothing here reads a "kind" off an event: the kind is the evaluated value's brand, minted by the
// built-in that produced it. Every delivery carries `{ after, through }`; per subscription the loop
// remembers the last `through` it handed over, so a batch the filter skipped still rides inside the
// next delivered range. A cursor target additionally receives ephemerals when it is caught up (they
// ride the pushed batch; they are not in the log), never when it is behind.

import {
  type ItxExpression,
  callOn,
  walkSteps,
  FacetHandle,
  RpcStubHandle,
} from "../context/expression.ts";
import { errorCode, reportIssue, withTimeout } from "../lib.ts";
import { type StreamEvent, consumesEvent, type ScannedRange } from "./processor.ts";
import type { Subscription } from "./core-processor.ts";
import type { Stream, SubscriptionCursor } from "./stream.ts";

/** A cursor delivery's awaited call is bounded by this; it is also how far ahead the lane arms the
 *  alarm before the call — by the time it fires the call has acked (the cursor row is written) or
 *  failed (the ladder armed), and an eviction in between leaves the alarm behind to re-derive. */
const CURSOR_DELIVERY_CALL_WATCHDOG_MS = 20_000;

/** THE IN-FLIGHT BUDGET, per context: the most serialized event chars ALL rows together may have
 *  handed to calls that have not settled — a push's arguments live in this isolate until the RPC
 *  returns, and per-row bounds would multiply by rows (20 stuck rows × 8 MiB is an isolate). A facet
 *  push or a cursor delivery WAITS for room (its row's pending push folds meanwhile, bounded); a
 *  push to a live client is dropped past it — the client heals by read, every dropped push's contract.
 *  8 MiB, not 16: a FACET push is a LOOPBACK RPC, so each in-flight push holds the event AND its
 *  serialize copy (~2× the charged chars), and the fan-out pins those arg payloads across a burst of
 *  concurrent appends (30 × 7 MiB ephemerals to 10 facets reset the parent at 16 — this budget is
 *  what the fan-out retains on top of the args workerd is deserializing; e2e LARGE EPHEMERAL FAN-OUT). */
const DELIVERY_IN_FLIGHT_BUDGET_CHARS = 8 * 1024 * 1024;
/** THE CURSOR-READ BUDGET: the most chars the CURSOR lane may hold across its read-through-call at
 *  once — a SEPARATE ceiling from the push budget so a cursor reserving a worst-case page never trips
 *  a live-client push drop. N cursor rows firing on one commit each read a page and hold the batch
 *  across the awaited call; without this they coexist (20 × an 8 MiB page = 160 MiB, a reset). A
 *  worst-case page is READ_PAGE_BUDGET_BYTES of stored BODIES (8 MiB — a lone event at
 *  EVENT_BODY_MAX_CHARS rides alone); with each event's offset and path it serializes to slightly
 *  MORE, so a full catch-up page OVERFILLS it: the read branch holds the whole budget from before the
 *  read and only ever RELEASES (the overshoot stays charged as the page), so big catch-up serializes
 *  and the next cursor read WAITS; a small batch is trimmed to its real size and frees the reserve so
 *  small cursor deliveries stay concurrent and no call head-of-line-blocks the lane. */
const CURSOR_READ_BUDGET_CHARS = 8 * 1024 * 1024;
/** THE PENDING-PUSH BUDGET, per context: the most serialized event chars ALL rows together may hold
 *  back while their deliveries are in flight. Past it the OLDEST events are dropped from the LARGEST
 *  queue first and that push's `after` moves up to the last dropped offset — the span a facet heals
 *  from the log (its ephemerals are gone; nothing can redeliver an ephemeral). One read page, so a
 *  stuck subscriber costs this actor one page, not every commit since it stalled. No per-row bound
 *  beside it: a row past 8 MiB on its own is past the total and is the largest queue, so the trim
 *  starts there and holds back the same 8 MiB. 8 MiB, not 16: the pending queue pins ephemeral arg
 *  payloads the same way the in-flight budget does (above). */
const PENDING_PUSHES_TOTAL_BUDGET_CHARS = 8 * 1024 * 1024;

/** A failure that can only repeat — halt the row now, not after the ladder: the flag workerd itself
 *  stamps (`retryable: false`, processor.ts's ReduceCheckpointTable stamps it too) or one of OUR codes that a
 *  retry cannot change (a target that is not callable, nothing matching the target's expression,
 *  a checkpoint or an event over its ceiling). */
const deterministicFailure = (error: unknown): boolean =>
  (error as { retryable?: unknown } | null)?.retryable === false ||
  [
    "NOT_A_METHOD",
    "NO_ITX_EXPRESSION_MATCH",
    "REDUCE_CHECKPOINT_TOO_LARGE",
    "EVENT_TOO_LARGE",
  ].includes(errorCode(error) ?? "");

/** One row's push waiting behind its in-flight delivery — later commits fold into it; `chars` is
 *  measured only once something has folded in (a push the closure takes at once costs no stringify). */
type PendingPush = {
  events: StreamEvent[];
  range: ScannedRange;
  chars?: number;
  droppedEvents: number;
};

const serializedChars = (events: StreamEvent[]): number =>
  events.reduce((n, event) => n + JSON.stringify(event).length, 0);

/** The target of a row, evaluated — and FOR WHICH row: a row's identity is its `configuredAtOffset`
 *  (halt and resume keep it; a re-configure changes it), so an evaluation done for a row since
 *  replaced is dropped and the replacement's target is evaluated instead. */
type EvaluatedSubscriptionTarget = {
  call: (args: unknown[]) => Promise<unknown>;
  forRowConfiguredAtOffset: number;
};

/** Everything the loop remembers about ONE subscription row this incarnation, by name — made on
 *  first touch and dropped whole when the row is replaced or removed (`#forgetSubscription`). */
type SubscriptionDeliveryRecord = {
  /** Deliveries queue here: a slow target never lets a later batch overtake an earlier one. */
  deliveryChain: Promise<unknown>;
  /** THE ONE push waiting behind the in-flight delivery: a commit landing while one waits FOLDS
   *  into it (one range, one call, one facet commit) — never a closure per commit. Its presence IS
   *  "a delivery closure is coming": the closure takes it before it delivers. */
  pendingPush?: PendingPush;
  /** The last `through` handed over — a batch the filter skipped rides inside the next range. */
  lastDeliveredThroughOffset?: number;
  /** The freshest pushed batch of a CURSOR row — how ephemerals reach a caught-up cursor target
   *  (the log has no ephemerals; the push does). Latest wins; a stale one is ignored. */
  pushedEventBatch?: { events: StreamEvent[]; after: number; through: number };
  /** The cursor, in memory — the truth for this incarnation; the `subscription_cursors` table
   *  mirrors it at DURABLE boundaries only (an ephemeral-only batch advances memory and touches no
   *  storage: ephemerals are not in the log, and after an eviction the persisted cursor rewinds to
   *  the last durable boundary and durables are redelivered from there, which at-least-once allows).
   *  Absent for a push target. */
  cursor?: SubscriptionCursor;
  /** THE PUSH/CURSOR BIT: true once the target LAST evaluated to a handle that OWNS ITS PROGRESS (a
   *  facet, a lent rpc stub) this incarnation. SET where the head is evaluated, never derived: a
   *  materialization's or resume's catch-up, the alarm's row pass, and the push path — which
   *  RE-classifies, so a row re-pointed at a target that cannot own its progress clears the bit and
   *  the alarm's pass and the commit-time arming see it again. A fresh incarnation classifies again. */
  targetOwnsProgress: boolean;
  /** The evaluated target head, reused across pushes: a row delivered every commit (a PCM stream,
   *  an audio call) would otherwise re-walk its target and re-mint a Facet/RpcStub handle on EVERY
   *  push. Valid while the row's identity (`configuredAtOffset`) AND the rewrite-rule table (its
   *  object identity in core state — any `provide`/un-set replaces it) are unchanged; either moving
   *  re-evaluates. */
  evaluatedTargetHead?: {
    configuredAtOffset: number;
    rewriteRulesRef: object;
    head: unknown;
    call: (args: unknown[]) => Promise<unknown>;
  };
};

/** A CHARS BUDGET with waiters — the most serialized event chars one lane may hold at once.
 *  `acquire` waits for room (a call larger than the whole budget runs alone when nothing is held —
 *  never a deadlock); `release` wakes every waiter, each re-checks; `tryTake` takes the room now or
 *  refuses (the live-client push's drop). Two instances, kept apart on purpose (the constants above). */
class DeliveryCharsBudget {
  readonly #budgetChars: number;
  #heldChars = 0;
  readonly #waiters: (() => void)[] = [];

  constructor(budgetChars: number) {
    this.#budgetChars = budgetChars;
  }

  get heldChars(): number {
    return this.#heldChars;
  }

  async acquire(chars: number): Promise<void> {
    while (this.#heldChars > 0 && this.#heldChars + chars > this.#budgetChars)
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#heldChars += chars;
  }

  release(chars: number): void {
    this.#heldChars -= chars;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  tryTake(chars: number): boolean {
    if (this.#heldChars + chars > this.#budgetChars) return false;
    this.#heldChars += chars;
    return true;
  }
}

type SubscriptionDeliveryDeps = {
  /** The stream: its rows (`coreReducedState.subscriptions`), its log, its durable mark, its alarm. */
  stream: Stream;
  /** Evaluate an itx expression through the context's own dispatch — a handle, a function, a value. */
  evaluateItxExpression: (expression: ItxExpression) => Promise<unknown>;
  /** A delivery finished — the quiet clock restarts (the quiesce must not fire mid-traffic). */
  recordActivityForQuietClock: () => void;
};

export class SubscriptionDelivery {
  readonly #stream: Stream;
  readonly #evaluateItxExpression: SubscriptionDeliveryDeps["evaluateItxExpression"];
  readonly #recordActivityForQuietClock: () => void;
  /** What the loop remembers per row, by name (SubscriptionDeliveryRecord). */
  readonly #deliveryRecordByName = new Map<string, SubscriptionDeliveryRecord>();
  /** The cursor lane's lock, per NAME and outside the record on purpose: one `#deliverFromCursor`
   *  loop drains a name at a time, and the loop that was draining a row when it was replaced goes on
   *  to deliver the replacement once its call returns — so the lock outlives `#forgetSubscription`. */
  readonly #cursorDeliveryRunning = new Set<string>();
  /** Chars handed to calls that have not settled, all rows (DELIVERY_IN_FLIGHT_BUDGET_CHARS). */
  readonly #deliveryCharsInFlight = new DeliveryCharsBudget(DELIVERY_IN_FLIGHT_BUDGET_CHARS);
  /** The CURSOR lane's read-through-call — a SEPARATE ceiling (CURSOR_READ_BUDGET_CHARS says why). */
  readonly #cursorReadCharsInFlight = new DeliveryCharsBudget(CURSOR_READ_BUDGET_CHARS);

  constructor(deps: SubscriptionDeliveryDeps) {
    this.#stream = deps.stream;
    this.#evaluateItxExpression = deps.evaluateItxExpression;
    this.#recordActivityForQuietClock = deps.recordActivityForQuietClock;
    // The persisted cursors seed memory once, here — after this, memory is the one truth.
    for (const [name, cursor] of this.#stream.storage.listSubscriptionCursors())
      this.#deliveryRecordFor(name).cursor = cursor;
  }

  /** The record under `name`, made on first touch. */
  #deliveryRecordFor(name: string): SubscriptionDeliveryRecord {
    let record = this.#deliveryRecordByName.get(name);
    if (!record) {
      record = { deliveryChain: Promise.resolve(), targetOwnsProgress: false };
      this.#deliveryRecordByName.set(name, record);
    }
    return record;
  }

  /** The post-commit hook: one pass over the rows. Fire-and-forget from append's view. */
  onCommit(freshEvents: StreamEvent[], afterOffset: number, throughOffset: number): void {
    const rows = this.#stream.coreReducedState.subscriptions;
    for (const event of freshEvents) {
      switch (event.type) {
        case "events.iterate.com/stream/subscription-delivery-resumed": {
          // An operator's resume is itself the wake: deliver that name NOW, whatever its `consumes`
          // says (the resumed fact is rarely a type the subscriber asked for, and a halted row has no
          // retry armed — without this it would wait for the next matching commit or the quiet clock).
          const name = (event.payload as { name: string }).name;
          const row = rows[name];
          if (!row) break;
          // A halted FACET row resumes by catching up from the log itself; anything else by the
          // cursor lane. Classified by EVALUATING, never by the record's push bit: a fresh
          // incarnation knows no push rows, and the cursor lane, meeting a facet, only classifies it
          // and returns — the undelivered span would wait for the next consumed commit.
          void this.#catchUpFacetRow(name, row)
            .then((facet) => (facet ? undefined : this.#deliverFromCursor(name)))
            .catch((error) => reportIssue("subscription-delivery.resume", error, { name }));
          break;
        }
        case "events.iterate.com/stream/subscription-configured": {
          // A configured row REPLACES (a `null` target REMOVES; only the forget runs): everything
          // remembered under this name belonged to the old target. The new target is evaluated right
          // away, whatever its `consumes` says — a processor's facet is materialized at enable time
          // and catches up from the log, so `itx.facets.get(name)` answers before its first consumed
          // event, and a target whose head cannot be evaluated is reported here, at configure. That
          // catch-up is the HEAD of this name's delivery chain, so the first push queues behind it.
          const name = (event.payload as { name: string }).name;
          this.#forgetSubscription(name);
          const row = rows[name];
          if (row)
            this.#deliveryRecordFor(name).deliveryChain = this.#catchUpFacetRow(name, row)
              .then((facet) =>
                // A row that asked for HISTORY (`afterOffset`) is delivered from there NOW — its
                // configure is its wake, as a resume is — not on its next consumed commit.
                facet || row.afterOffset === undefined ? undefined : this.#deliverFromCursor(name),
              )
              .catch((error) => {
                // NO_FACET here is a disable that landed during the load — nothing to report.
                if (errorCode(error) !== "NO_FACET")
                  reportIssue("subscription-delivery.configured", error, { name });
              });
          break;
        }
      }
    }
    for (const [name, row] of Object.entries(rows)) {
      if (row.halted) continue; // an operator's resume is the only way back (the case above)
      const events = freshEvents.filter((event) => consumesEvent(row.consumes, event));
      // A skipped batch is NOT handed over: the watermark stays put and the span rides inside the
      // NEXT delivered range.
      if (events.length === 0) continue;
      const record = this.#deliveryRecordFor(name);
      const after = record.lastDeliveredThroughOffset ?? afterOffset;
      record.lastDeliveredThroughOffset = throughOffset;
      if (!record.targetOwnsProgress) {
        // Remembered for the CURSOR lane only; a row known to own its progress would just retain the
        // batch until its next delivery.
        record.pushedEventBatch = { events, after, through: throughOffset };
        // A delivery is owed from here: an eviction before the cursor lane even evaluates the
        // target must leave an alarm behind to come back.
        this.#stream.armAlarmNoLaterThan(Date.now() + CURSOR_DELIVERY_CALL_WATCHDOG_MS);
      }
      this.#queuePushBehindInFlightDelivery(name, events, { after, through: throughOffset });
    }
  }

  /** Evaluate a row's target and, when it is a facet, have it catch up from the log (a
   *  materialization at configure, or a resume). TRUE when there is nothing more for the caller to
   *  do: the target was a facet, or the row was SUPERSEDED while its target evaluated (a superseded
   *  evaluation classifies nothing and calls nothing). FALSE for a target that cannot own its
   *  progress: the caller's to deliver from the cursor. */
  async #catchUpFacetRow(name: string, row: Subscription): Promise<boolean> {
    const { head } = await this.#evaluateItxExpressionTargetHead(row.target);
    if (
      this.#stream.coreReducedState.subscriptions[name]?.configuredAtOffset !==
      row.configuredAtOffset
    )
      return true;
    if (!(head instanceof FacetHandle)) return false;
    // Classify it as a PUSH row NOW, so onCommit never retains its batches as a pushed batch — the
    // cursor-lane memo, UNBOUNDED by the delivery budgets. A burst to freshly-enabled facets would
    // otherwise pin one ephemeral per facet there (10 × 7 MiB) on top of the args workerd is
    // deserializing, and reset the parent (the large-ephemeral fan-out: 0 facets absorbed, 10 not).
    const record = this.#deliveryRecordFor(name);
    record.targetOwnsProgress = true;
    record.pushedEventBatch = undefined;
    try {
      await head.invoke([["catchUpFromLog"]]);
    } catch (error) {
      // A catch-up refused for good (a latched checkpoint, an event over its ceiling) HALTS the row
      // as a push's refusal would (below) — else the row stays live, re-pushed into the same wall on
      // every commit, and an operator's resume that was refused reads as if it had worked.
      if (deterministicFailure(error)) {
        this.#haltRow(name, row.configuredAtOffset, row.configuredAtOffset, 1, error);
        return true;
      }
      throw error;
    }
    return true;
  }

  /** Queue a push behind the row's in-flight delivery — or FOLD it into the one already waiting
   *  (trimmed past PENDING_PUSHES_TOTAL_BUDGET_CHARS). */
  #queuePushBehindInFlightDelivery(name: string, events: StreamEvent[], range: ScannedRange): void {
    const record = this.#deliveryRecordFor(name);
    const pending = record.pendingPush;
    if (pending) {
      pending.chars = (pending.chars ?? serializedChars(pending.events)) + serializedChars(events);
      pending.events = pending.events.concat(events); // a fresh array: the old one may be an in-flight call's argument
      pending.range.through = range.through;
      this.#dropPendingEventsOverTotalBudget();
      return;
    }
    record.pendingPush = { events, range, droppedEvents: 0 };
    record.deliveryChain = record.deliveryChain
      .then(async () => {
        // Read again: the record may have been dropped (#forgetSubscription) while this waited.
        const current = this.#deliveryRecordByName.get(name);
        const push = current?.pendingPush;
        if (current) current.pendingPush = undefined;
        const row = this.#stream.coreReducedState.subscriptions[name];
        // Removed meanwhile (#forgetSubscription emptied it) — or HALTED meanwhile: a halted row is
        // skipped by every commit from then on, and a push already waiting is no exception (it would
        // push into the same refusal and stack a second halt on the first).
        if (!push || !row || row.halted) return;
        if (push.droppedEvents > 0)
          console.warn({
            event: "delivery.pending-push.dropped",
            namespace: "subscription-delivery",
            message:
              "a subscriber did not keep up: the oldest pending events were dropped (a facet heals durables from the log; the span's ephemerals are lost)",
            name,
            droppedEvents: push.droppedEvents,
            healFromOffset: push.range.after,
          });
        await this.#deliverEventBatch(name, row, push.events, push.range);
      })
      .catch(() => undefined);
  }

  /** Drop the OLDEST events of a pending push until it holds at most `keepUnderChars` (never its
   *  newest): `after` moves up to the last dropped offset — the span a facet heals from the log. */
  #dropOldestPendingEvents(pending: PendingPush, keepUnderChars: number): void {
    let dropCount = 0;
    while (pending.chars! > keepUnderChars && dropCount < pending.events.length - 1)
      pending.chars! -= JSON.stringify(pending.events[dropCount++]).length;
    if (dropCount === 0) return;
    pending.range.after = pending.events[dropCount - 1].offset;
    pending.events = pending.events.slice(dropCount);
    pending.droppedEvents += dropCount;
  }

  /** The cross-row total: past PENDING_PUSHES_TOTAL_BUDGET_CHARS, take from the LARGEST measured
   *  queue that can still shrink, until under. An unmeasured queue (one push, nothing folded yet)
   *  counts as nothing — it is at most one commit's batch. */
  #dropPendingEventsOverTotalBudget(): void {
    for (;;) {
      let total = 0;
      let largest: PendingPush | undefined;
      for (const { pendingPush } of this.#deliveryRecordByName.values()) {
        if (pendingPush?.chars === undefined) continue;
        total += pendingPush.chars;
        if (pendingPush.events.length > 1 && (!largest || pendingPush.chars > largest.chars!))
          largest = pendingPush;
      }
      const excess = total - PENDING_PUSHES_TOTAL_BUDGET_CHARS;
      if (excess <= 0 || !largest) return;
      this.#dropOldestPendingEvents(largest, largest.chars! - excess);
    }
  }

  /** The alarm's half: every cursor subscription — a due retry, or one an eviction left mid-delivery.
   *  ROW-driven (the header says why); a row not yet known as a push row is classified on the way.
   *  Cheap when nothing is due: one read per cursor row, nothing per known push row. */
  async deliverEveryCursorSubscription(): Promise<void> {
    await Promise.all(
      Object.keys(this.#stream.coreReducedState.subscriptions)
        .filter((name) => !this.#deliveryRecordByName.get(name)?.targetOwnsProgress)
        .map((name) =>
          this.#deliverFromCursor(name).catch((error) =>
            reportIssue("subscription-delivery.cursor", error, { name }),
          ),
        ),
    );
  }

  /** The cursor of a subscription the stream delivers at-least-once — absent for a push target. */
  cursor(name: string): SubscriptionCursor | undefined {
    return this.#deliveryRecordByName.get(name)?.cursor;
  }

  /** Everything remembered about the row under `name` goes with it — the persisted cursor too. A
   *  closure still queued finds no pending push and exits; the cursor lane's lock stays (above). */
  #forgetSubscription(name: string): void {
    this.#stream.storage.deleteSubscriptionCursor(name);
    this.#deliveryRecordByName.delete(name);
  }

  #dropCursor(name: string): void {
    const record = this.#deliveryRecordByName.get(name);
    if (record) record.cursor = undefined;
    this.#stream.storage.deleteSubscriptionCursor(name);
  }

  /** Memory always; the table only when `persist` (a durable boundary moved, a ladder step, a halt,
   *  a resume — never an ephemeral-only advance). */
  #adoptCursor(name: string, cursor: SubscriptionCursor, persist: boolean): void {
    this.#deliveryRecordFor(name).cursor = cursor;
    if (persist) this.#stream.storage.writeSubscriptionCursor(name, cursor);
  }

  // ── one batch, one subscription: evaluate, look at the value, push or cursor ──

  async #deliverEventBatch(
    name: string,
    row: Subscription,
    events: StreamEvent[],
    range: ScannedRange,
  ): Promise<void> {
    try {
      // The row must still be THIS row on BOTH sides of the (async) evaluation — not removed
      // (evaluating a processor's load chain materializes its facet: a push racing a disable must
      // not resurrect what `facets.delete` just removed) and not REPLACED under this name.
      if (!this.#stream.coreReducedState.subscriptions[name]) return;
      const { head, call } = await this.#evaluateTargetHeadForRow(name, row);
      if (
        this.#stream.coreReducedState.subscriptions[name]?.configuredAtOffset !==
        row.configuredAtOffset
      )
        return;
      const record = this.#deliveryRecordFor(name);
      if (head instanceof FacetHandle || head instanceof RpcStubHandle) {
        record.targetOwnsProgress = true;
        // A cursor born while the target evaluated to something else (a rule re-point): not this row's.
        if (record.cursor) this.#dropCursor(name);
      } else {
        // Re-pointed at a target that cannot own its progress: the alarm's pass must see it again.
        record.targetOwnsProgress = false;
      }
      if (head instanceof RpcStubHandle) {
        // A LIVE CLIENT owns its offset: fire-and-forget — the pager socket is the queue, and a
        // stalled client blocks nothing but itself. RPC_STUB_OFFLINE is the benign heal-by-pull case
        // (the row stays until its last pager closes); anything else is a real drop worth a line.
        record.pushedEventBatch = undefined;
        const chars = serializedChars(events);
        if (!this.#deliveryCharsInFlight.tryTake(chars)) {
          console.warn({
            event: "delivery.push.dropped",
            namespace: "subscription-delivery",
            message:
              "push delivery dropped: the context's in-flight budget is full (the subscriber heals by read)",
            name,
            healFromOffset: range.after,
            inFlightChars: this.#deliveryCharsInFlight.heldChars,
          });
          return;
        }
        void call([events, range])
          .catch((error) => {
            if (errorCode(error) !== "RPC_STUB_OFFLINE")
              console.warn({
                event: "delivery.push.dropped",
                namespace: "subscription-delivery",
                message: "push delivery dropped",
                name,
                error: String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
              });
          })
          .finally(() => this.#deliveryCharsInFlight.release(chars));
        return;
      }
      if (head instanceof FacetHandle) {
        // A FACET owns its checkpoint: push, AWAITED, so this facet's batches stay in order and the
        // quiesce never aborts it mid-reduce. The DO's facet watchdog (#invokeFacet, 60 s) bounds a
        // hung facet; its own gap repair covers a dropped push.
        record.pushedEventBatch = undefined;
        try {
          const chars = serializedChars(events);
          await this.#deliveryCharsInFlight.acquire(chars);
          try {
            await call([events, range]);
          } finally {
            this.#deliveryCharsInFlight.release(chars);
          }
        } catch (error) {
          // A refusal that can only repeat HALTS the row — the same fact the cursor lane's ladder
          // ends in — instead of being re-pushed into on every commit; an operator's resume is the
          // way back. Anything else is the facet's own gap repair to heal on its next push.
          if (deterministicFailure(error)) {
            this.#haltRow(name, row.configuredAtOffset, range.after, 1, error);
            return;
          }
          throw error;
        }
        return;
      }
      // CANNOT own progress: the stream keeps the cursor. The pushed batch was remembered in onCommit;
      // the cursor delivery takes it when contiguous, else it pages the log.
      await this.#deliverFromCursor(name, {
        call,
        forRowConfiguredAtOffset: row.configuredAtOffset,
      });
    } catch (error) {
      // NO_FACET is a disable that landed under an in-flight push — the row is gone too.
      // NO_ITX_EXPRESSION_MATCH is a row that DANGLES (its rule removed, or not configured yet): it
      // errors until the rule lands and revives with it, so a push into it is no issue per commit.
      const code = errorCode(error);
      if (code !== "NO_FACET" && code !== "NO_ITX_EXPRESSION_MATCH")
        reportIssue("subscription-delivery.deliver", error, { name });
    } finally {
      this.#recordActivityForQuietClock();
    }
  }

  /** HALT ONCE, FOR THE RIGHT ROW — the one place the `subscription-delivery-halted` fact is
   *  appended. Append is synchronous, so the check and the fact are ONE turn: the row must still be
   *  the one the failing call was made for (a replacement never inherits its predecessor's refusal)
   *  and not halted already — a push and a resume's catch-up seeing the same refusal append one
   *  fact between them, never two. */
  #haltRow(
    name: string,
    configuredAtOffset: number,
    afterOffset: number,
    attempts: number,
    error: unknown,
  ): void {
    const current = this.#stream.coreReducedState.subscriptions[name];
    if (current?.configuredAtOffset !== configuredAtOffset || current.halted) return;
    this.#stream.append({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: {
        name,
        afterOffset,
        attempts,
        // Clipped: the message lands in the halted event AND the core state's row (checkpointed
        // with every core change) — a target that throws a response body must not bloat either.
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
      },
    });
  }

  /** The push path's memo of the evaluated target head (`evaluatedTargetHead` says what invalidates it). */
  async #evaluateTargetHeadForRow(
    name: string,
    row: Subscription,
  ): Promise<{ head: unknown; call: (args: unknown[]) => Promise<unknown> }> {
    const rewriteRulesRef = this.#stream.coreReducedState.itxExpressionRewriteRules;
    const cached = this.#deliveryRecordByName.get(name)?.evaluatedTargetHead;
    if (
      cached &&
      cached.configuredAtOffset === row.configuredAtOffset &&
      cached.rewriteRulesRef === rewriteRulesRef
    )
      return { head: cached.head, call: cached.call };
    const evaluated = await this.#evaluateItxExpressionTargetHead(row.target);
    this.#deliveryRecordFor(name).evaluatedTargetHead = {
      configuredAtOffset: row.configuredAtOffset,
      rewriteRulesRef,
      head: evaluated.head,
      call: evaluated.call,
    };
    return evaluated;
  }

  /** Evaluate a target's HEAD (everything but a trailing method name) and return the value plus the
   *  one call to make on it. A target ending in a call step names the callee itself (a bare lent
   *  callback: `itx.rpcStubs.get('k')`); a trailing property step names the method to call on it
   *  (`…get('presence').processEventBatch`). */
  async #evaluateItxExpressionTargetHead(
    target: ItxExpression,
  ): Promise<{ head: unknown; call: (args: unknown[]) => Promise<unknown> }> {
    const last = target.at(-1);
    // A trailing name is a METHOD only past the root and one more step: a two-step target
    // (`itx.<alias>`) IS the callee and is root-called whole — peeling its name would leave the bare
    // scope root as the head, which nothing can ever match.
    const method = typeof last === "string" && target.length > 2 ? last : undefined;
    const head = await this.#evaluateItxExpression(method ? target.slice(0, -1) : target);
    const call = async (args: unknown[]): Promise<unknown> =>
      method
        ? (await walkSteps({ value: head, receiver: undefined }, [[method, ...args]])).value
        : callOn(head, undefined, args);
    return { head, call };
  }

  // ── the stream-kept cursor: at-least-once, from the cursor row, the awaited call is the ack ──

  /** `evaluatedTarget` is the target the push path already evaluated, for the row it evaluated it
   *  for; the alarm's pass and a resume evaluate here — lazily, only once there is a batch to
   *  deliver, and inside the ladder. One loop per name at a time; the loop drains. */
  async #deliverFromCursor(
    name: string,
    evaluatedTarget?: EvaluatedSubscriptionTarget,
  ): Promise<void> {
    if (this.#cursorDeliveryRunning.has(name)) return;
    this.#cursorDeliveryRunning.add(name);
    try {
      for (;;) {
        const row = this.#stream.coreReducedState.subscriptions[name];
        if (!row) return this.#forgetSubscription(name);
        let cursor = this.cursor(name);
        if (!cursor) {
          // A subscription's FIRST cursor: born where the row asked (`afterOffset`; 0 = the whole
          // log) or at its configuration offset ("now"), in memory only — the first durable delivery
          // writes it.
          cursor = { confirmedOffset: row.afterOffset ?? row.configuredAtOffset, attempt: 0 };
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
          this.#stream.armAlarmNoLaterThan(cursor.nextAttemptAtMs);
          return;
        }
        // The batch: the pushed one when contiguous (ephemerals ride it); else a page of the log, read
        // only UP TO the pushed batch's start, so that once the durables before it are delivered the
        // cursor IS contiguous with it and takes it. A pushed batch the cursor has already passed is
        // stale and forgotten. Cursor-read room (CURSOR_READ_BUDGET_CHARS) is held from BEFORE the
        // read — the READ is what allocates — THROUGH the awaited call, released once in the finally.
        let inFlightRoomHeld = 0;
        try {
          const record = this.#deliveryRecordFor(name); // the cursor above put it there
          let pushedEventBatch = record.pushedEventBatch;
          if (pushedEventBatch && pushedEventBatch.after < cursor.confirmedOffset) {
            record.pushedEventBatch = undefined;
            pushedEventBatch = undefined;
          }
          let eventBatch: { events: StreamEvent[]; through: number };
          if (pushedEventBatch && pushedEventBatch.after === cursor.confirmedOffset) {
            record.pushedEventBatch = undefined;
            eventBatch = { events: pushedEventBatch.events, through: pushedEventBatch.through };
          } else {
            await this.#cursorReadCharsInFlight.acquire(CURSOR_READ_BUDGET_CHARS);
            inFlightRoomHeld = CURSOR_READ_BUDGET_CHARS;
            const page = this.#stream.read(cursor.confirmedOffset, 100);
            const ceiling = pushedEventBatch
              ? Math.min(page.scannedThroughOffset, pushedEventBatch.after)
              : page.scannedThroughOffset;
            if (ceiling <= cursor.confirmedOffset) return; // caught up (the finally releases the room)
            eventBatch = {
              events: page.events.filter(
                (event) => event.offset <= ceiling && consumesEvent(row.consumes, event),
              ),
              through: ceiling,
            };
          }
          const range: ScannedRange = {
            after: cursor.confirmedOffset,
            through: eventBatch.through,
          };
          const durable = eventBatch.events.some((event) => !event.ephemeral);
          // Adjust the held room to the batch's REAL size. The read branch (a worst-case page) only
          // ever RELEASES here — synchronous with the read, no yield, so a second read never piles a
          // page on: a SMALL batch frees the reserve so a racing PUSH is not dropped for a full
          // budget. A page that serializes PAST the reserve (a full page: offset and path ride on top
          // of the bodies) stays charged as the page — acquiring the overshoot while holding the
          // whole budget would wait on this very reservation, forever, and every cursor row behind
          // it. The pushed branch (held 0) acquires its batch's worth, which may wait.
          const batchChars = serializedChars(eventBatch.events);
          if (inFlightRoomHeld === 0) {
            await this.#cursorReadCharsInFlight.acquire(batchChars);
            inFlightRoomHeld = batchChars;
          } else if (batchChars < inFlightRoomHeld) {
            this.#cursorReadCharsInFlight.release(inFlightRoomHeld - batchChars);
            inFlightRoomHeld = batchChars;
          }
          if (eventBatch.events.length === 0) {
            this.#adoptCursor(name, { ...cursor, confirmedOffset: range.through }, true); // a log page: durable ground
            continue;
          }
          try {
            if (evaluatedTarget?.forRowConfiguredAtOffset !== row.configuredAtOffset) {
              const { head, call } = await this.#evaluateItxExpressionTargetHead(row.target);
              if (head instanceof FacetHandle || head instanceof RpcStubHandle) {
                // Reached by the alarm's row-driven pass: a target that owns its progress is never this
                // lane's — remember that, and drop the birth cursor above (this lane's guess).
                this.#deliveryRecordFor(name).targetOwnsProgress = true;
                this.#dropCursor(name);
                return;
              }
              evaluatedTarget = { call, forRowConfiguredAtOffset: row.configuredAtOffset };
              if (!this.cursor(name)) continue; // replaced while the target was evaluated
            }
            // Die mid-call and the alarm survives to re-derive from the rows.
            this.#stream.armAlarmNoLaterThan(Date.now() + CURSOR_DELIVERY_CALL_WATCHDOG_MS);
            const target = evaluatedTarget;
            await withTimeout(
              target.call([eventBatch.events, range]),
              CURSOR_DELIVERY_CALL_WATCHDOG_MS,
              `subscription "${name}"`,
            );
            // Removed or replaced while the call was in flight? Its progress belonged to the old row —
            // and so did the evaluation: the identity check above re-evaluates for the replacement.
            if (!this.cursor(name)) continue;
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
            if (!this.cursor(name)) continue; // replaced mid-flight: re-evaluated for the new row
            // A delivery-resumed that landed DURING this attempt is not yet applied: loop back and apply
            // it instead of arming the old ladder or, worse, appending a halt on top of the operator's resume.
            const latest = this.#stream.coreReducedState.subscriptions[name];
            if (latest?.resumed && latest.resumed.atOffset !== cursor.resumeAppliedAtOffset)
              continue;
            const attempt = cursor.attempt + 1;
            // A failure that can only repeat halts now, not in half an hour.
            if (deterministicFailure(error) || attempt >= 15) {
              this.#adoptCursor(name, { ...cursor, attempt: 0 }, true);
              this.#haltRow(name, row.configuredAtOffset, cursor.confirmedOffset, attempt, error);
              return;
            }
            const backoff =
              Math.min(1000 * 2 ** (attempt - 1), 1_800_000) * (0.8 + Math.random() * 0.4);
            const nextAttemptAtMs = Date.now() + Math.round(backoff);
            this.#adoptCursor(name, { ...cursor, attempt, nextAttemptAtMs }, true);
            this.#stream.armAlarmNoLaterThan(nextAttemptAtMs);
            return;
          }
        } finally {
          if (inFlightRoomHeld > 0) this.#cursorReadCharsInFlight.release(inFlightRoomHeld);
        }
      }
    } finally {
      this.#cursorDeliveryRunning.delete(name);
    }
  }
}
