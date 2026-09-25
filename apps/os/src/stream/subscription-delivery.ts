// subscription-delivery.ts — THE ONE DELIVERY LOOP, run from the stream's post-commit hook: for every
// subscription row, filter the batch by `consumes` and deliver it the way the row's TARGET decides:
//
//   • a target that RESOLVES (through the rule table — core-processor.ts `targetOwnsProgress`,
//     decided from the rules alone, never by evaluating it) to a facet or a lent rpc stub OWNS ITS
//     PROGRESS — a facet keeps its own checkpoint and gap-repairs from the log, a live client owns
//     its offset and heals with read — so it gets a PUSH of `(events, { after, through })`, one
//     delivery chain per subscription;
//   • anything else cannot own progress, so THE STREAM KEEPS A CURSOR for it (a `subscription_cursors`
//     row, never in the log): the awaited call IS the ack, one bounded retry ladder (1s·2ⁿ, ≤30 min,
//     15 attempts, `retryable: false` halts at once) then a `subscription-delivery-halted` fact; an
//     operator's `subscription-delivery-resumed` un-halts and may seek. Retries ride the DO's own
//     alarm (facets have none, workerd#6810 — which is why this is kernel code, not a facet processor).
//
// AT-LEAST-ONCE survives an eviction because a cursor row's claim on the DO's alarm is EXACTLY the
// time its persisted cursor carries (`nextAttemptAtMs`; `deadlines()`, which alarm-coordinator.ts
// reconciles against): written the instant its loop starts on a row behind the durable mark — inside
// the commit's own hook, before any read or call — as "an attempt begins: come back by now + 20 s",
// with the attempt counted; written by the retry ladder as the rung; cleared by the ack; spent when
// the loop finds nothing owed or a target nothing resolves. So a death anywhere in a delivery is
// retried by the next incarnation within 20 s, a batch that keeps killing its caller halts after
// fifteen attempts, as fifteen refusals would, and NOTHING IN MEMORY IS A REASON TO WAKE.
//
// A FACET IS PUSHED THE PLATFORM'S WAY: a row's target evaluates to the facet's FacetHandle, and the
// loop's push and catch-up hand that handle to the facet host's `callFacetAsPlatform`
// (context/facet-host.ts) — never the handle's own walk, which reaches only what the facet's class
// lists for callers (context/facet-public-methods.ts). A facet row whose target names any other
// method is walked like any caller's call.
//
// Nothing here reads a "kind" off an event: the kind is the evaluated value's brand, minted by the
// built-in that produced it. Every delivery carries `{ after, through }`; per subscription the loop
// remembers the last `through` it handed over, so a batch the filter skipped still rides inside the
// next delivered range. A cursor target receives ephemerals too: its reads merge in the stream's
// recent-ephemerals ring (stream.ts), so it sees whatever the ring still holds when its loop reads.

import type { ItxExpression } from "iterate/expression";
import { errorCode, reportIssue, withTimeout } from "iterate/lib";
import type { StreamPage } from "iterate/api";
import { type StreamEvent, consumesEvent, type ScannedRange } from "iterate/stream/processor";
import { callOn, walkSteps, FacetHandle, RpcStubHandle } from "../context/dispatch.ts";
import { type Subscription, targetOwnsProgress } from "./core-processor.ts";
import { RECENT_EPHEMERALS_BUDGET_CHARS, type Stream, type SubscriptionCursor } from "./stream.ts";

/** A cursor delivery's awaited call is bounded by this; it is also how far ahead a row behind the
 *  durable mark claims the alarm — by the time it fires the call has acked (the cursor row is
 *  written) or failed (the ladder took over), and an eviction in between leaves the alarm behind. */
const CURSOR_DELIVERY_CALL_WATCHDOG_MS = 20_000;
/** The most attempts — claims and failures counted together — one cursor row gets on one batch
 *  before it halts. */
const CURSOR_DELIVERY_MAX_ATTEMPTS = 15;

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
/** THE CURSOR-READ BUDGET: the most chars CURSOR delivery may hold across its read-through-call at
 *  once — a SEPARATE ceiling from the push budget so a cursor reserving a worst-case page never trips
 *  a live-client push drop. N cursor rows firing on one commit each read a page and hold the batch
 *  across the awaited call; without this they coexist (20 × an 8 MiB page = 160 MiB, a reset). A
 *  worst-case page is READ_PAGE_BUDGET_BYTES of stored BODIES (8 MiB — a lone event at
 *  EVENT_BODY_MAX_CHARS rides alone); with each event's offset and path it serializes to slightly
 *  MORE, so a full catch-up page OVERFILLS it: the read branch holds the whole budget from before the
 *  read and only ever RELEASES (the overshoot stays charged as the page), so big catch-up serializes
 *  and the next cursor read WAITS; a small batch is trimmed to its real size and frees the reserve so
 *  small cursor deliveries stay concurrent and no call head-of-line-blocks the other cursor rows.
 *  A row AT the mark reads nothing but the stream's recent-ephemerals ring and reserves that ring's
 *  size instead. */
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

/** A failure that can only repeat — halt the row now, not after the ladder: `retryable: false`, our
 *  own stamp (processor.ts's ReduceCheckpointTable; workerd only ever sets `retryable: true`), or one
 *  of OUR codes that a retry cannot change (a target that is not callable, a checkpoint or an event
 *  over its ceiling). Never NO_ITX_EXPRESSION_MATCH: a target nothing resolves DANGLES
 *  (`danglingUnder`), it is not halted. */
const deterministicFailure = (error: unknown): boolean =>
  (error as { retryable?: unknown } | null)?.retryable === false ||
  [
    "NOT_A_METHOD",
    "REDUCE_CHECKPOINT_TOO_LARGE",
    "EVENT_TOO_LARGE",
    "FORBIDDEN", // a target this context may not reach (a global path that is not its own): a retry cannot change who the caller is
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

/** Everything the loop remembers about ONE subscription row this incarnation, by name — made on
 *  first touch and dropped whole when the row is replaced or removed (`#forgetSubscription`). */
type SubscriptionDeliveryRecord = {
  /** Pushes queue here: a slow target never lets a later batch overtake an earlier one. */
  deliveryChain: Promise<unknown>;
  /** THE ONE push waiting behind the in-flight delivery: a commit landing while one waits FOLDS
   *  into it (one range, one call, one facet commit) — never a closure per commit. Its presence IS
   *  "a delivery closure is coming": the closure takes it before it delivers. */
  pendingPush?: PendingPush;
  /** The last `through` a PUSH row handed over — a batch the filter skipped rides inside the next
   *  range. A cursor row's watermark is its cursor. */
  lastDeliveredThroughOffset?: number;
  /** The cursor, in memory — the truth for this incarnation; the `subscription_cursors` table
   *  mirrors it at DURABLE boundaries only (an ephemeral-only batch advances memory and touches no
   *  storage: ephemerals are not in the log, and after an eviction the persisted cursor rewinds to
   *  the last durable boundary and durables are redelivered from there, which at-least-once allows).
   *  Absent for a push target. */
  cursor?: SubscriptionCursor;
  /** The evaluated target head, reused across pushes: a row delivered every commit (a PCM stream,
   *  an audio call) would otherwise re-walk its target and re-mint a Facet/RpcStub handle on EVERY
   *  push. Valid while the row's identity (`configuredAtOffset`) AND the rewrite-rule table (its
   *  object identity in core state — any `provide`/un-set replaces it) are unchanged; either moving
   *  re-evaluates. */
  evaluatedTargetHead?: {
    configuredAtOffset: number;
    rewriteRulesRef: object;
    head: unknown;
    call: (events: StreamEvent[], range: ScannedRange) => Promise<void>;
  };
};

/** A CHARS BUDGET with waiters — the most serialized event chars one kind of delivery may hold.
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
  /** The stream: its rows (`coreReducedState.subscriptions`), its log, its durable mark. */
  stream: Stream;
  /** Evaluate an itx expression through the context's own dispatch — a handle, a function, a value. */
  evaluateItxExpression: (expression: ItxExpression) => Promise<unknown>;
  /** A facet row's push: `processEventBatch(events, range)` on the facet a target evaluated to, the
   *  platform's way (the facet host's `callFacetAsPlatform`). */
  pushEventBatchToFacet: (
    facetHandle: FacetHandle,
    events: StreamEvent[],
    range: ScannedRange,
  ) => Promise<unknown>;
  /** A facet row's catch-up from the log, the platform's way. */
  catchUpFacetFromLog: (facetHandle: FacetHandle) => Promise<unknown>;
  /** A row's claim changed OFF the commit path (a commit's own tail reconciles): the DO
   *  reconciles its alarm against `deadlines()`. */
  reconcileAlarm: () => void;
};

/** One cursor row's claim on the DO's alarm, for `deadlines()` and the trace: the persisted
 *  `nextAttemptAtMs` and the attempt it belongs to. */
export type DeliveryDeadline = { name: string; at: number; attempt: number };

export class SubscriptionDelivery {
  readonly #stream: Stream;
  readonly #evaluateItxExpression: SubscriptionDeliveryDeps["evaluateItxExpression"];
  readonly #pushEventBatchToFacet: SubscriptionDeliveryDeps["pushEventBatchToFacet"];
  readonly #catchUpFacetFromLog: SubscriptionDeliveryDeps["catchUpFacetFromLog"];
  readonly #reconcileAlarm: SubscriptionDeliveryDeps["reconcileAlarm"];
  /** What the loop remembers per row, by name (SubscriptionDeliveryRecord). */
  readonly #deliveryRecordByName = new Map<string, SubscriptionDeliveryRecord>();
  /** Cursor delivery's lock, per NAME and outside the record on purpose: one `#deliverFromCursor`
   *  loop drains a name at a time, and the loop that was draining a row when it was replaced goes on
   *  to deliver the replacement once its call returns — so the lock outlives `#forgetSubscription`.
   *  The value is the running loop's promise, so a second kick JOINS it: the alarm's pass awaits a
   *  delivery already in flight and derives its deadline after the ack. Written before the loop's
   *  first turn and deleted by the loop itself, synchronously with its last act. */
  readonly #cursorDeliveryLoops = new Map<string, Promise<void>>();
  /** Chars handed to calls that have not settled, all rows (DELIVERY_IN_FLIGHT_BUDGET_CHARS). */
  readonly #deliveryCharsInFlight = new DeliveryCharsBudget(DELIVERY_IN_FLIGHT_BUDGET_CHARS);
  /** CURSOR delivery's read-through-call — a SEPARATE ceiling (CURSOR_READ_BUDGET_CHARS says why). */
  readonly #cursorReadCharsInFlight = new DeliveryCharsBudget(CURSOR_READ_BUDGET_CHARS);

  constructor(deps: SubscriptionDeliveryDeps) {
    this.#stream = deps.stream;
    this.#evaluateItxExpression = deps.evaluateItxExpression;
    this.#pushEventBatchToFacet = deps.pushEventBatchToFacet;
    this.#catchUpFacetFromLog = deps.catchUpFacetFromLog;
    this.#reconcileAlarm = deps.reconcileAlarm;
    // The persisted cursors seed memory once, here — after this, memory is the one truth.
    for (const [name, cursor] of this.#stream.storage.listSubscriptionCursors())
      this.#deliveryRecordFor(name).cursor = cursor;
  }

  /** The record under `name`, made on first touch. */
  #deliveryRecordFor(name: string): SubscriptionDeliveryRecord {
    let record = this.#deliveryRecordByName.get(name);
    if (!record) {
      record = { deliveryChain: Promise.resolve() };
      this.#deliveryRecordByName.set(name, record);
    }
    return record;
  }

  /** Every cursor row's claim on the alarm, earliest first (the loop's deadline is `[0]?.at`):
   *  EXACTLY the persisted `nextAttemptAtMs` of a row not halted — the claim its loop wrote as it
   *  started, a ladder rung, or the claim a death left, ahead or due alike (a due one keeps the alarm
   *  armed until its pass runs). A fresh incarnation reports the same claims its predecessor did,
   *  because nothing in memory is one: a caught-up row, a dangling row and a halted row (whose
   *  persisted cursor may still carry the time that halted it) carry none the alarm reads, and a
   *  target that owns its progress has no cursor at all. */
  deadlines(): DeliveryDeadline[] {
    const state = this.#stream.coreReducedState;
    const deadlines: DeliveryDeadline[] = [];
    for (const [name, record] of this.#deliveryRecordByName) {
      const at = record.cursor?.nextAttemptAtMs;
      const row = state.subscriptions[name];
      if (at === undefined || !row || row.halted) continue;
      deadlines.push({ name, at, attempt: record.cursor!.attempt });
    }
    return deadlines.sort((a, b) => a.at - b.at);
  }

  /** The post-commit hook: one pass over the rows. Fire-and-forget from append's view. */
  onCommit(freshEvents: StreamEvent[], afterOffset: number, throughOffset: number): void {
    const state = this.#stream.coreReducedState;
    const rows = state.subscriptions;
    const durable = freshEvents.some((event) => !event.ephemeral);
    for (const event of freshEvents) {
      switch (event.type) {
        case "events.iterate.com/itx/subscription-delivery-resumed": {
          // An operator's resume is itself the wake: deliver that name NOW, whatever its `consumes`
          // says (the resumed fact is rarely a type the subscriber asked for, and a halted row has no
          // retry armed — without this it would wait for the next matching commit).
          // A halted FACET row resumes by catching up from the log itself; a cursor row from its cursor.
          // The payload passed normalizeControlEvent on append, which parsed the name.
          const name = (event.payload as { name: string }).name;
          const row = rows[name];
          if (!row) break;
          void (
            targetOwnsProgress(state, row)
              ? this.#catchUpFacetRow(name, row)
              : this.#deliverFromCursor(name)
          ).catch((error) =>
            this.#reportFacetRowFailure("subscription-delivery.resume", name, row, error),
          );
          break;
        }
        case "events.iterate.com/itx/subscription-configured": {
          // A configured row REPLACES (a `null` target REMOVES; only the forget runs): everything
          // remembered under this name belonged to the old target. A row that owns its progress is
          // evaluated right away, whatever its `consumes` says — a processor's facet is materialized
          // at enable time and catches up from the log, so `itx.facets.get(name)` answers before its
          // first consumed event, and a target whose head cannot be evaluated is reported here, at
          // configure. That catch-up is the HEAD of this name's delivery chain, so the first push
          // queues behind it. A cursor row that asked for HISTORY (`afterOffset`) is delivered from
          // there NOW — its configure is its wake, as a resume is — not on its next consumed commit.
          // The payload passed normalizeControlEvent on append, which parsed the name.
          const name = (event.payload as { name: string }).name;
          this.#forgetSubscription(name);
          const row = rows[name];
          if (!row) break;
          if (targetOwnsProgress(state, row))
            this.#deliveryRecordFor(name).deliveryChain = this.#catchUpFacetRow(name, row).catch(
              (error) => {
                // NO_FACET on the row still in place addresses a facet no longer hosted, as a push
                // into it does (below).
                if (errorCode(error) === "NO_FACET" && this.#isStillTheRow(name, row)) return;
                this.#reportFacetRowFailure("subscription-delivery.configured", name, row, error);
              },
            );
          else if (row.afterOffset !== undefined)
            void this.#deliverFromCursor(name).catch((error) =>
              reportIssue("subscription-delivery.configured", error, { name }),
            );
          break;
        }
      }
    }
    for (const [name, row] of Object.entries(rows)) {
      if (row.halted) continue; // an operator's resume is the only way back (the case above)
      const record = this.#deliveryRecordFor(name);
      const events = freshEvents.filter((event) => consumesEvent(row.consumes, event));
      if (targetOwnsProgress(state, row)) {
        // A cursor row RE-POINTED at a target that owns its progress (a rule commit): the stream's
        // cursor is nothing of the target's — it goes, and with it the row's claim.
        if (record.cursor) {
          record.cursor = undefined;
          this.#stream.storage.deleteSubscriptionCursor(name);
        }
        // A skipped batch is NOT handed over: the watermark stays put and the span rides inside the
        // NEXT delivered range.
        if (events.length === 0) continue;
        const after = record.lastDeliveredThroughOffset ?? afterOffset;
        record.lastDeliveredThroughOffset = throughOffset;
        this.#queuePushBehindInFlightDelivery(name, events, { after, through: throughOffset });
        continue;
      }
      if (events.length === 0) {
        // A batch this row does not consume: a caught-up idle row is moved along HERE, as an ack
        // would move it — one page read saved per such commit per idle cursor row (the loop would
        // advance it the same way, one read later). Caught up means confirmed through the head as
        // it stood before this batch, ephemerals included: a row still owed a ring ephemeral reads.
        const cursor = record.cursor || {
          confirmedOffset: row.afterOffset ?? row.configuredAtOffset,
          attempt: 0,
        };
        if (
          !this.#cursorDeliveryLoops.has(name) &&
          cursor.nextAttemptAtMs === undefined &&
          cursor.confirmedOffset >= afterOffset
        ) {
          this.#adoptCursor(name, { ...cursor, confirmedOffset: throughOffset }, durable);
          continue;
        }
        // An ephemeral-only batch owes any other row nothing: its loop, when it next runs, reads
        // past what the ring holds and takes what it consumes.
        if (!durable) continue;
      }
      // The loop reads the batch itself — the log, with the ring's ephemerals merged in.
      void this.#deliverFromCursor(name).catch((error) =>
        reportIssue("subscription-delivery.cursor", error, { name }),
      );
    }
  }

  /** Evaluate a row that owns its progress and, when it is a facet, have it catch up from the log
   *  (a materialization at configure, or a resume). A row SUPERSEDED while its target evaluated
   *  calls nothing; a lent rpc stub catches up by its own reads. */
  async #catchUpFacetRow(name: string, row: Subscription): Promise<void> {
    const { head } = await this.#evaluateItxExpressionTargetHead(row.target);
    if (
      this.#stream.coreReducedState.subscriptions[name]?.configuredAtOffset !==
      row.configuredAtOffset
    )
      return;
    if (!(head instanceof FacetHandle)) return;
    try {
      await this.#catchUpFacetFromLog(head);
    } catch (error) {
      // A catch-up refused for good (a latched checkpoint, an event over its ceiling) HALTS the row
      // as a push's refusal would (below) — else the row stays live, re-pushed into the same wall on
      // every commit, and an operator's resume that was refused reads as if it had worked.
      if (deterministicFailure(error)) {
        this.#haltRow(name, row.configuredAtOffset, row.configuredAtOffset, 1, error);
        return;
      }
      // A catch-up an `itx.facets.abort` or a platform restart (a new loaded identity, another
      // call's timeout) cut off is owed by the fresh instance: run it there.
      const code = errorCode(error);
      if (code === "FACET_ABORTED" || code === "FACET_RESTARTED")
        return this.#catchUpFacetRow(name, row);
      throw error;
    }
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
        await this.#pushEventBatch(name, row, push.events, push.range);
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

  /** The alarm's half: every cursor row — a due retry, a claim an eviction left mid-delivery, or a
   *  row behind the mark. ROW-driven (the header says why); cheap when nothing is due: one read per
   *  cursor row, nothing for a row that owns its progress. A row a loop already holds is JOINED
   *  and awaited: the pass ends with every loop drained, so no claim leaves a pass due. */
  async deliverEveryCursorSubscription(): Promise<void> {
    const state = this.#stream.coreReducedState;
    await Promise.all(
      Object.entries(state.subscriptions)
        .filter(([, row]) => !row.halted && !targetOwnsProgress(state, row))
        .map(([name]) =>
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
   *  closure still queued finds no pending push and exits; cursor delivery's lock stays (above). */
  #forgetSubscription(name: string): void {
    this.#stream.storage.deleteSubscriptionCursor(name);
    this.#deliveryRecordByName.delete(name);
    this.#reconcileAlarm();
  }

  /** Memory always; the table only when `persist` (a durable boundary moved, a claim before a call,
   *  a ladder step, a halt, a resume — never an ephemeral-only advance). The table never names an
   *  offset past the durable mark: memory may stand on a head ephemeral, whose number a later
   *  incarnation can hand to a durable (stream.ts's contract), so what is written is clamped. */
  #adoptCursor(name: string, cursor: SubscriptionCursor, persist: boolean): void {
    this.#deliveryRecordFor(name).cursor = cursor;
    if (persist)
      this.#stream.storage.writeSubscriptionCursor(name, {
        ...cursor,
        confirmedOffset: Math.min(cursor.confirmedOffset, this.#stream.highestDurableOffset()),
      });
  }

  // ── one batch, one row that owns its progress: evaluate, look at the value, push ──

  async #pushEventBatch(
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
      if (head instanceof RpcStubHandle) {
        // A LIVE CLIENT owns its offset: fire-and-forget — the pager socket is the queue, and a
        // stalled client blocks nothing but itself. RPC_STUB_OFFLINE is the benign heal-by-pull case
        // (the row stays until its last pager closes; a page that timed out is logged where it
        // timed out, context/rpc-stubs.ts); anything else is a real drop worth a line.
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
        void call(events, range)
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
      // A FACET owns its checkpoint: push, AWAITED, so this facet's batches stay in order. The DO's
      // facet watchdog (FacetHost#call, 60 s) bounds a hung facet; its own gap repair covers a
      // dropped push.
      try {
        const chars = serializedChars(events);
        await this.#deliveryCharsInFlight.acquire(chars);
        try {
          await call(events, range);
        } finally {
          this.#deliveryCharsInFlight.release(chars);
        }
      } catch (error) {
        // A refusal that can only repeat HALTS the row — the same fact cursor delivery's ladder
        // ends in — instead of being re-pushed into on every commit; an operator's resume is the
        // way back. Anything else is the facet's own gap repair to heal on its next push.
        if (deterministicFailure(error)) {
          this.#haltRow(name, row.configuredAtOffset, range.after, 1, error);
          return;
        }
        // A push the watchdog TIMED OUT aborted the facet (FacetHost#call): the batch was never
        // checkpointed and nothing else redelivers it, so the restarted facet CATCHES UP from the
        // log — queued behind whatever already waits on this row (a later push heals the same gap
        // on its own; the catch-up is then a no-op). ONE catch-up per timed-out push: a batch that
        // is slow every time costs two aborts per commit and never loops. A push an
        // `itx.facets.abort` cut off (FACET_ABORTED) is the same loss, asked for, and so is one a
        // platform restart cut off (FACET_RESTARTED: a new loaded identity, or ANOTHER call on the
        // facet timed out — this push keeps no TIMEOUT of its own): caught up alike.
        const code = errorCode(error);
        if (code === "TIMEOUT" || code === "FACET_ABORTED" || code === "FACET_RESTARTED")
          this.#catchUpAfterPushTimeout(name, row);
        throw error;
      }
    } catch (error) {
      // NO_ITX_EXPRESSION_MATCH is a row that DANGLES (its rule removed, or not configured yet): it
      // errors until the rule lands and revives with it, so a push into it is no issue per commit;
      // so is NO_FACET on a row still in place, which addresses a facet no longer hosted.
      // FACET_ABORTED is a reset someone asked for, its batch caught up above.
      const code = errorCode(error);
      if (code === "NO_ITX_EXPRESSION_MATCH" || code === "FACET_ABORTED") return;
      // FACET_RESTARTED is a platform restart (a code change, another call's timeout), its batch
      // caught up above: logged, no issue.
      if (code === "FACET_RESTARTED") {
        console.log({
          event: "delivery.facet-restarted-in-flight",
          namespace: "subscription-delivery",
          failureSite: "subscription-delivery.deliver",
          name,
          code,
        });
        return;
      }
      if (code === "NO_FACET" && this.#isStillTheRow(name, row)) return;
      this.#reportFacetRowFailure("subscription-delivery.deliver", name, row, error);
    }
  }

  /** A facet row's delivery that failed: NO_FACET once the row is gone or replaced is the removal it
   *  raced — a disable, a delete, the facet taken with its row (`ctx.facets.delete` fails a call in
   *  flight, FacetHost `#call`) — an outcome, logged; anything else is an issue. */
  #reportFacetRowFailure(
    failureSite: string,
    name: string,
    row: Subscription,
    error: unknown,
  ): void {
    if (errorCode(error) === "NO_FACET" && !this.#isStillTheRow(name, row)) {
      console.log({
        event: "delivery.facet-removed-in-flight",
        namespace: "subscription-delivery",
        failureSite,
        name,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    reportIssue(failureSite, error, { name });
  }

  /** The row under `name` is still the one configured at `row`'s offset — neither removed nor replaced. */
  #isStillTheRow(name: string, row: Subscription): boolean {
    return (
      this.#stream.coreReducedState.subscriptions[name]?.configuredAtOffset ===
      row.configuredAtOffset
    );
  }

  /** The catch-up a timed-out push owes (above), or one an `itx.facets.abort` cut off: chained, so
   *  it runs after this row's in-flight delivery and before anything queued later; a catch-up that
   *  fails is reported, never retried. */
  #catchUpAfterPushTimeout(name: string, row: Subscription): void {
    const record = this.#deliveryRecordFor(name);
    record.deliveryChain = record.deliveryChain.then(() =>
      this.#catchUpFacetRow(name, row).catch((error) =>
        this.#reportFacetRowFailure(
          "subscription-delivery.catch-up-after-timeout",
          name,
          row,
          error,
        ),
      ),
    );
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
    // A halted row owes nothing; the fact's own commit reconciles the alarm.
    this.#stream.append({
      type: "events.iterate.com/itx/subscription-delivery-halted",
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

  /** Halt a CURSOR row: its cursor first spends the claim or rung it carries (attempt 0, no retry
   *  time), so a resume starts a fresh ladder — then the halted fact (`#haltRow`). A row replaced
   *  while the attempt ran is left alone: the replacement's cursor is not this batch's. */
  #haltCursorRow(
    name: string,
    row: Subscription,
    cursor: SubscriptionCursor,
    attempts: number,
    error: unknown,
  ): void {
    if (
      this.#stream.coreReducedState.subscriptions[name]?.configuredAtOffset !==
      row.configuredAtOffset
    )
      return;
    const { nextAttemptAtMs: _spent, ...settled } = cursor;
    this.#adoptCursor(name, { ...settled, attempt: 0 }, true);
    this.#haltRow(name, row.configuredAtOffset, cursor.confirmedOffset, attempts, error);
  }

  /** The memo of the evaluated target head (`evaluatedTargetHead` says what invalidates it). */
  async #evaluateTargetHeadForRow(
    name: string,
    row: Subscription,
  ): Promise<{
    head: unknown;
    call: (events: StreamEvent[], range: ScannedRange) => Promise<void>;
  }> {
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
   *  (`…get('presence').processEventBatch`) — on a facet, the facet host's push. */
  async #evaluateItxExpressionTargetHead(target: ItxExpression): Promise<{
    head: unknown;
    call: (events: StreamEvent[], range: ScannedRange) => Promise<void>;
  }> {
    const last = target.at(-1);
    // A trailing name is a METHOD only past the root and one more step: a two-step target
    // (`itx.<alias>`) IS the callee and is root-called whole — peeling its name would leave the bare
    // scope root as the head, which nothing can ever match.
    const method = typeof last === "string" && target.length > 2 ? last : undefined;
    const head = await this.#evaluateItxExpression(method ? target.slice(0, -1) : target);
    // Every delivery below AWAITS this only for the ack and IGNORES the return. A Workers-RPC/capnweb
    // call result pins the callee's export table until disposed, so release it here — a live client's
    // push runs on every commit, and leaving each result to GC would leak a slot per delivered batch.
    const call = async (events: StreamEvent[], range: ScannedRange): Promise<void> => {
      if (head instanceof FacetHandle && method === "processEventBatch") {
        await this.#pushEventBatchToFacet(head, events, range);
        return;
      }
      const walked = method
        ? (await walkSteps({ value: head, receiver: undefined }, [[method, events, range]])).value
        : await callOn(head, undefined, [events, range]);
      // A PIPELINED call answers with a branded promise the step walk hands back UNAWAITED
      // (context/dispatch.ts): settle it HERE, before the dispose — otherwise a sibling hop's refusal
      // (FORBIDDEN from the target context) or a hang was disposed unseen and the batch acked as
      // delivered. The settled value is what pins the callee, so that is what is released.
      const result = await walked;
      if (typeof result === "object" && result && Symbol.dispose in result)
        (result as Disposable)[Symbol.dispose]();
    };
    return { head, call };
  }

  // ── the stream-kept cursor: at-least-once, from the cursor row, the awaited call is the ack ──

  /** One loop per name at a time; a kick while one runs joins it. The loop drains: every commit,
   *  resume and alarm pass kicks it, and it evaluates the target lazily — only once there is a
   *  batch to deliver, and inside the ladder. */
  #deliverFromCursor(name: string): Promise<void> {
    const running = this.#cursorDeliveryLoops.get(name);
    if (running) return running;
    // The lock is written before the drain's first turn: a drain can end on that turn (no row, a
    // halted row, a rung not yet due), and registering its promise afterwards would leave the
    // settled promise as the lock. It is released by the drain's own `finally`, never by a `.then`
    // on its promise: a release deferred to a microtask would let a kick landing in between join a
    // loop that delivers nothing more.
    let resolveLoop: (() => void) | undefined;
    let rejectLoop: ((error: unknown) => void) | undefined;
    const loop = new Promise<void>((resolve, reject) => {
      resolveLoop = resolve;
      rejectLoop = reject;
    });
    this.#cursorDeliveryLoops.set(name, loop);
    this.#drainCursor(name).then(resolveLoop, rejectLoop);
    return loop;
  }

  async #drainCursor(name: string): Promise<void> {
    // A claim written on the commit's own turn is armed by the commit's reconcile, and one written
    // after an ack rides the alarm the previous claim armed; the claim a restart (below) causes has
    // neither behind it and arms the alarm itself.
    let claimArmsTheAlarm = false;
    try {
      for (;;) {
        const row = this.#stream.coreReducedState.subscriptions[name];
        if (!row) return this.#forgetSubscription(name);
        // Re-pointed at a target that owns its progress meanwhile: cursor delivery no longer applies.
        if (targetOwnsProgress(this.#stream.coreReducedState, row)) return;
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
        // A rung (or a claim an eviction left) not yet due: its time is the row's claim, and
        // whatever kicked this loop (a commit's tail, a pass's end) reconciles the alarm to it.
        if (cursor.nextAttemptAtMs !== undefined && Date.now() < cursor.nextAttemptAtMs) return;
        // THE CLAIM, the instant an attempt begins on a row behind the durable mark — SYNCHRONOUS
        // with the commit that kicked this loop, before any read, evaluation or call: die anywhere
        // from here and the next incarnation reads it from the cursor table — the attempt this is,
        // and when to come back. Fifteen attempts with neither an ack nor a failure halt the row, as
        // fifteen refusals would (a batch that kills its caller is a refusal that can only repeat).
        // A row at the mark is owed nothing durable; what the ring may hold for it is memory, and
        // nothing in memory is a reason to wake.
        const cursorBeforeAttempt = cursor;
        const behindTheDurableMark = cursor.confirmedOffset < this.#stream.highestDurableOffset();
        if (behindTheDurableMark) {
          const attempt = cursor.attempt + 1;
          // Every earlier attempt died without an ack or a failure: no (MAX+1)th claim is made.
          if (attempt > CURSOR_DELIVERY_MAX_ATTEMPTS) {
            this.#haltCursorRow(
              name,
              row,
              cursor,
              cursor.attempt,
              new Error(
                `${cursor.attempt} deliveries of this batch ended without an ack or a failure (the context died mid-call)`,
              ),
            );
            return;
          }
          cursor = {
            ...cursor,
            attempt,
            nextAttemptAtMs: Date.now() + CURSOR_DELIVERY_CALL_WATCHDOG_MS,
          };
          this.#adoptCursor(name, cursor, true);
          if (claimArmsTheAlarm) {
            claimArmsTheAlarm = false;
            this.#reconcileAlarm();
          }
        }
        // The batch: one page of the log with the ring's ephemerals merged in (stream.ts `read`),
        // from the cursor — which, after an ephemeral-only ack, stands on that ephemeral's offset in
        // memory, so a re-read holds only what is newer. Cursor-read room is held from BEFORE the
        // read — the READ is what allocates — THROUGH the awaited call, released once in the
        // finally: a row behind the mark reads a page of unknown size and reserves the whole
        // CURSOR_READ_BUDGET_CHARS and the ring; a row at the mark can read nothing but the ring and
        // reserves its size, so a row waiting for room pins no batch of its own (what the ring lets go
        // while it waits is not delivered, as a pending push loses what is dropped from it).
        let inFlightRoomHeld = 0;
        try {
          // The ring rides on top of a page, and may hold one event as large as the append ceiling.
          const ringChars = Math.max(
            RECENT_EPHEMERALS_BUDGET_CHARS,
            this.#stream.recentEphemeralsChars(),
          );
          const reserveChars = behindTheDurableMark
            ? CURSOR_READ_BUDGET_CHARS + ringChars
            : ringChars;
          await this.#cursorReadCharsInFlight.acquire(reserveChars);
          inFlightRoomHeld = reserveChars;
          // An at-mark row reserved the ring as it stood before the wait. A durable that landed
          // meanwhile put it behind the mark — no claim, no page's worth of room — and an ephemeral
          // that landed may have outgrown the reserve: start the iteration over (the finally
          // releases the room); the next turn claims if it must, and reserves what it will read.
          const behindNow = cursor.confirmedOffset < this.#stream.highestDurableOffset();
          if (
            !behindTheDurableMark &&
            (behindNow || this.#stream.recentEphemeralsChars() > ringChars)
          ) {
            claimArmsTheAlarm = behindNow;
            continue;
          }
          let page: StreamPage;
          try {
            page = this.#stream.read(cursor.confirmedOffset, 100, { includeEphemeral: true });
          } catch (error) {
            // A row this subscription can never read past (EVENT_UNREADABLE) is a refusal that
            // can only repeat: halt now, as the ladder's end would — never a retry into it.
            this.#haltCursorRow(name, row, cursor, cursorBeforeAttempt.attempt + 1, error);
            return;
          }
          // Ephemerals the ring let go of before this row read them are lost to it (nothing
          // redelivers an ephemeral) — and said, as a dropped push is.
          const owedAfterOffset = Math.max(cursor.confirmedOffset, row.configuredAtOffset);
          const lostThroughOffset = Math.max(
            0,
            ...(row.consumes || []).map(
              (type) => this.#stream.evictedEphemeralThroughOffset(type) ?? 0,
            ),
          );
          if (lostThroughOffset > owedAfterOffset)
            console.warn({
              event: "delivery.cursor.ephemerals-evicted",
              namespace: "subscription-delivery",
              message:
                "a cursor subscriber did not keep up: the ring let go of ephemerals it had not read",
              name,
              owedAfterOffset,
              lostThroughOffset,
            });
          // What this delivery hands over: the log's proof, or the head ephemeral past it — an
          // offset that lives in memory only, which is where the cursor keeps it.
          const through = Math.max(page.scannedThroughOffset, page.events.at(-1)?.offset ?? 0);
          if (through <= cursor.confirmedOffset) {
            // CAUGHT UP: nothing owed, no claim (the finally releases the room). This is the
            // row's normal end — a wake that found nothing to do must not arm another. A claim
            // or a ladder still set (its batch was ephemeral, and the ring let it go) is spent
            // with it; an attempt that found nothing to deliver was no death.
            if (cursor.nextAttemptAtMs !== undefined) {
              const { nextAttemptAtMs: _spent, ...settled } = cursor;
              this.#adoptCursor(name, { ...settled, attempt: 0 }, true);
            }
            return;
          }
          const events = page.events.filter((event) => consumesEvent(row.consumes, event));
          const range: ScannedRange = { after: cursor.confirmedOffset, through };
          // The table follows only when the log's proof moved past the cursor or a claim stands
          // in it: an ephemeral-only pass on a quiet row touches no storage.
          const persist =
            page.scannedThroughOffset > cursor.confirmedOffset ||
            cursor.nextAttemptAtMs !== undefined;
          // Adjust the held room to the batch's REAL size — only ever RELEASING here, synchronous
          // with the read, no yield, so a second read never piles a page on: a SMALL batch frees
          // the reserve so other cursor rows keep flowing. A page that serializes PAST the reserve
          // (a full page: offset and path ride on top of the bodies) stays charged as the reserve —
          // acquiring the overshoot while holding the whole budget would wait on this very
          // reservation, forever, and every cursor row behind it.
          const batchChars = serializedChars(events);
          if (batchChars < inFlightRoomHeld) {
            this.#cursorReadCharsInFlight.release(inFlightRoomHeld - batchChars);
            inFlightRoomHeld = batchChars;
          }
          // A reconfigure that landed while this iteration awaited budget REPLACED the row
          // (#forgetSubscription cleared its cursor): this batch, offsets and `cursor` all belong to
          // the OLD target. Advancing now would write the old scan offset into the fresh row's cursor
          // — its afterOffset (a `0` = full history) never applied. Loop back to re-read and re-birth.
          if (
            this.#stream.coreReducedState.subscriptions[name]?.configuredAtOffset !==
            row.configuredAtOffset
          )
            continue;
          if (events.length === 0) {
            // A page the filter emptied: advanced without a call, no attempt spent; the loop goes
            // on to whatever is owed. A claim or a due ladder time that reached here is spent —
            // kept, it would be a past claim.
            const { nextAttemptAtMs: _spent, ...settled } = cursor;
            this.#adoptCursor(
              name,
              { ...settled, attempt: cursorBeforeAttempt.attempt, confirmedOffset: through },
              persist,
            );
            continue;
          }
          try {
            const { call } = await this.#evaluateTargetHeadForRow(name, row);
            if (!this.cursor(name)) continue; // replaced while the target was evaluated
            await withTimeout(
              call(events, range),
              CURSOR_DELIVERY_CALL_WATCHDOG_MS,
              `subscription "${name}"`,
            );
            // Removed or replaced while the call was in flight? Its progress belonged to the old row —
            // and so did the evaluation: the identity check above re-evaluates for the replacement.
            if (!this.cursor(name)) continue;
            // THE ACK: attempt 0, no time; a commit that landed during the call is owed by
            // derivation (the loop finds the row behind the mark and goes on). Memory takes the
            // whole span, a head ephemeral's offset included, so the next read returns only what is
            // newer and nothing is handed over twice; the table takes the durable part (`#adoptCursor`).
            this.#adoptCursor(
              name,
              {
                confirmedOffset: through,
                attempt: 0,
                resumeAppliedAtOffset: cursor.resumeAppliedAtOffset,
              },
              persist,
            );
          } catch (error) {
            if (!this.cursor(name)) continue; // replaced mid-flight: re-evaluated for the new row
            // The target DANGLES: nothing resolves it under this rule table (a `subscribe` before
            // its `provide`, a rule since removed; a sibling context's rule missing at the call).
            // No rung, no halt, no claim, no attempt spent: the row waits for its rule — the commit
            // that lands it kicks every cursor row, and this loop evaluates the target anew then.
            if (errorCode(error) === "NO_ITX_EXPRESSION_MATCH") {
              const { nextAttemptAtMs: _spent, ...settled } = cursorBeforeAttempt;
              this.#adoptCursor(name, settled, true);
              return;
            }
            // A delivery-resumed that landed DURING this attempt is not yet applied: loop back and apply
            // it instead of arming the old ladder or, worse, appending a halt on top of the operator's resume.
            const latest = this.#stream.coreReducedState.subscriptions[name];
            if (latest?.resumed && latest.resumed.atOffset !== cursor.resumeAppliedAtOffset)
              continue;
            // The rung is written on the SAME attempt the claim was (one bump per attempt).
            const attempt = cursorBeforeAttempt.attempt + 1;
            // A failure that can only repeat halts now, not in half an hour.
            if (deterministicFailure(error) || attempt >= CURSOR_DELIVERY_MAX_ATTEMPTS) {
              this.#haltCursorRow(name, row, cursor, attempt, error);
              return;
            }
            const backoff =
              // 1s·2ⁿ, topped at half an hour
              Math.min(1000 * 2 ** (attempt - 1), 30 * 60_000) * (0.8 + Math.random() * 0.4);
            const nextAttemptAtMs = Date.now() + Math.round(backoff);
            // The ladder's time IS the row's claim from here (durable, so it survives eviction).
            this.#adoptCursor(name, { ...cursor, attempt, nextAttemptAtMs }, true);
            return;
          }
        } finally {
          if (inFlightRoomHeld > 0) this.#cursorReadCharsInFlight.release(inFlightRoomHeld);
        }
      }
    } finally {
      this.#cursorDeliveryLoops.delete(name);
      // Every way out reconciles ONCE, with the row released: what the row claims now — a rung, a
      // claim not yet due, nothing at all once caught up or halted — is the alarm's to arm.
      this.#reconcileAlarm();
    }
  }
}
