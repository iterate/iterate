// subscription-delivery.ts — post-commit delivery for live providers and processor facets.
// Context-owned runners keep durable subscription progress, retries, and dead letters.
// Pushes preserve a shared in-flight body budget and a per-row serialized chain.
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
// next delivered range.

import type { ItxExpression } from "iterate/expression";
import { codedError, errorCode, reportIssue } from "iterate/lib";
import {
  failureKind,
  isPlatformFailureKind,
  logPlatformFailure,
} from "@iterate-com/shared/platform-retry";
import { type StreamEvent, consumesEvent, type ScannedRange } from "iterate/stream/processor";
import { type Cause } from "../cause.ts";
import { callOn, walkSteps, FacetHandle, RpcStubHandle } from "../context/dispatch.ts";
import { rowsPushingFacet, type Subscription } from "./core-processor.ts";
import { type Stream } from "./stream.ts";

/** THE IN-FLIGHT BUDGET, per context: the most serialized event chars ALL rows together may have
 *  handed to calls that have not settled — a push's arguments live in this isolate until the RPC
 *  returns, and per-row bounds would multiply by rows (20 stuck rows × 8 MiB is an isolate). A facet
 *  a processor push waits for room while its pending batch folds; a live push drops and heals by
 *  read. 8 MiB keeps loopback serialization copies below the isolate ceiling. */
const DELIVERY_IN_FLIGHT_BUDGET_CHARS = 8 * 1024 * 1024;

/** Bound coalesced processor pushes across rows; trimmed batches heal from the stream log. */
const PENDING_PUSHES_TOTAL_BUDGET_CHARS = 8 * 1024 * 1024;
/** A failure that can only repeat — halt the row now, not after the ladder: a subscriber's
 *  PERMANENT_FAILURE, or one of OUR codes that a retry cannot change (a target that is not callable,
 *  a checkpoint or an event over its ceiling). Never NO_ITX_EXPRESSION_MATCH: a target nothing
 *  resolves DANGLES (`danglingUnder`), it is not halted. */
const deterministicFailure = (error: unknown): boolean =>
  [
    "PERMANENT_FAILURE",
    "NOT_A_METHOD",
    "REDUCE_CHECKPOINT_TOO_LARGE",
    "EVENT_TOO_LARGE",
    "FORBIDDEN", // a target this context may not reach (a global path that is not its own): a retry cannot change who the caller is
  ].includes(errorCode(error) ?? "");

/** A target refusal that is meaningful to delivery policy. */
export const TARGET_FAILURE_CODES: ReadonlySet<string> = new Set([
  "NO_ITX_EXPRESSION_MATCH",
  "NOT_A_METHOD",
  "FORBIDDEN",
  "GONE",
]);

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
  /** The last `through` a push row handed over; a skipped batch rides in the next range. */
  lastDeliveredThroughOffset?: number;
  /** The evaluated target head, reused across pushes: a row delivered every commit (a PCM stream,
   *  an audio call) would otherwise re-walk its target and re-mint a Facet/RpcStub handle on EVERY
   *  push. Valid while the row's identity (`configuredAtOffset`) AND the rewrite-rule table (its
   *  object identity in core state — any `provide`/un-set replaces it) are unchanged, and until the
   *  first snapshot of another context's rules it read expires; any of these moving re-evaluates. */
  evaluatedTargetHead?: {
    configuredAtOffset: number;
    rewriteRulesRef: object;
  } & EvaluatedTargetHead;
};

/** A target head and the ordinary batch call it resolves to. */
type EvaluatedTargetHead = {
  head: unknown;
  /** Until when the head may be reused: the first rule snapshot of another context expires then. */
  validUntil: number;
  /** Where it resolved: a head evaluated again that resolves elsewhere is a moved target. */
  routedTo: string;
  call: (events: StreamEvent[], range: ScannedRange) => Promise<void>;
  pushesFacet: boolean;
};

/** A CHARS BUDGET with waiters — the most serialized event chars one kind of delivery may hold.
 *  `tryTake` takes the room now or refuses (the live-client push's drop, a processor push's wait): a
 *  call larger than the whole budget takes it when nothing is held — never a deadlock. `acquire`
 *  waits until `tryTake` would; `release` wakes every waiter, each re-checks. Two instances, kept
 *  apart on purpose (the constants above). */
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
    while (!this.tryTake(chars)) await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  release(chars: number): void {
    this.#heldChars -= chars;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  tryTake(chars: number): boolean {
    if (this.#heldChars > 0 && this.#heldChars + chars > this.#budgetChars) return false;
    this.#heldChars += chars;
    return true;
  }
}

type SubscriptionDeliveryDeps = {
  /** The stream: its rows (`coreReducedState.subscriptions`), its log, its durable mark. */
  stream: Stream;
  /** Attached callbacks are live rows: they shadow a durable same-named row while their pager is
   * open, but never enter the event-sourced subscription table. */
  liveSubscriptions?: () => Record<string, Subscription>;
  /** Evaluate an itx expression through the context's own dispatch — a handle, a function, a value
   *  — until when the answer may be reused: the first rule snapshot of another context it read
   *  expires then (context/rule-snapshots.ts), `Infinity` when it read none — and where it RESOLVED
   *  (`routedTo`, the resolver's `evaluate`), which moves when a rule re-points what it names: the
   *  project's config pointer to a new publication. */
  evaluateItxExpression: (
    expression: ItxExpression,
  ) => Promise<{ value: unknown; validUntil: number; routedTo: string }>;
  /** Resolves local rewrite aliases without invoking their final method. */
  resolveItxExpression?: (expression: ItxExpression) => ItxExpression[];
  /** A facet row's push: `processEventBatch(events, range)` on the facet a target evaluated to, the
   *  platform's way (the facet host's `callFacetAsPlatform`). */
  pushEventBatchToFacet: (
    facetHandle: FacetHandle,
    events: StreamEvent[],
    range: ScannedRange,
  ) => Promise<unknown>;
  /** A facet row's catch-up from the log, the platform's way, caused by the row's configuration. */
  catchUpFacetFromLog: (facetHandle: FacetHandle, cause: Cause | undefined) => Promise<unknown>;
};

export class SubscriptionDelivery {
  readonly #stream: Stream;
  readonly #liveSubscriptions: () => Record<string, Subscription>;
  readonly #evaluateItxExpression: SubscriptionDeliveryDeps["evaluateItxExpression"];
  readonly #resolveItxExpression: SubscriptionDeliveryDeps["resolveItxExpression"];
  readonly #pushEventBatchToFacet: SubscriptionDeliveryDeps["pushEventBatchToFacet"];
  readonly #catchUpFacetFromLog: SubscriptionDeliveryDeps["catchUpFacetFromLog"];
  /** What the loop remembers per row, by name (SubscriptionDeliveryRecord). */
  readonly #deliveryRecordByName = new Map<string, SubscriptionDeliveryRecord>();
  /** Shared bound for live and processor pushes; live callbacks drop and heal by read at capacity. */
  readonly #deliveryCharsInFlight = new DeliveryCharsBudget(DELIVERY_IN_FLIGHT_BUDGET_CHARS);
  constructor(deps: SubscriptionDeliveryDeps) {
    this.#stream = deps.stream;
    this.#liveSubscriptions = deps.liveSubscriptions || (() => ({}));
    this.#evaluateItxExpression = deps.evaluateItxExpression;
    this.#resolveItxExpression = deps.resolveItxExpression;
    this.#pushEventBatchToFacet = deps.pushEventBatchToFacet;
    this.#catchUpFacetFromLog = deps.catchUpFacetFromLog;
  }

  #subscriptions(): Record<string, Subscription> {
    return { ...this.#stream.coreReducedState.subscriptions, ...this.#liveSubscriptions() };
  }
  #subscription(name: string): Subscription | undefined {
    return this.#liveSubscriptions()[name] || this.#stream.coreReducedState.subscriptions[name];
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

  /** The post-commit hook: one pass over the rows. Fire-and-forget from append's view. */
  onCommit(freshEvents: StreamEvent[], afterOffset: number, throughOffset: number): void {
    const rows = this.#subscriptions();
    for (const event of freshEvents) {
      switch (event.type) {
        case "events.iterate.com/itx/subscription-delivery-resumed": {
          const name = (event.payload as { name: string }).name;
          const row = rows[name];
          if (row?.delivery === "processor")
            void this.#catchUpFacetRow(name, row).catch((error) =>
              this.#reportFacetRowFailure("resume", name, row, error),
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
          // queues behind it.
          // The payload passed normalizeControlEvent on append, which parsed the name.
          const name = (event.payload as { name: string }).name;
          this.#forgetSubscription(name);
          const row = rows[name];
          if (!row) break;
          if (row.delivery === "processor")
            this.#deliveryRecordFor(name).deliveryChain = this.#catchUpFacetRow(name, row).catch(
              (error) => {
                // NO_FACET on the row still in place addresses a facet no longer hosted, as a push
                // into it does (below).
                if (errorCode(error) === "NO_FACET" && this.#isStillTheRow(name, row)) return;
                this.#reportFacetRowFailure("configured", name, row, error);
              },
            );
          // Live rows own their recovery. Context-owned runners handle durable rows.
          break;
        }
      }
    }
    for (const [name, row] of Object.entries(rows)) {
      if (row.halted) continue; // an operator's resume is the only way back (the case above)
      if (row.delivery === "durable") continue;
      const record = this.#deliveryRecordFor(name);
      const events = freshEvents.filter((event) => consumesEvent(row.consumes, event));
      if (row.delivery === "live" || row.delivery === "processor") {
        // Delivery ownership is fixed when the row is configured. A rule may re-point the capability
        // it calls, but never changes how the configured row is delivered.
        // A skipped batch is NOT handed over: the watermark stays put and the span rides inside the
        // NEXT delivered range.
        if (events.length === 0) continue;
        const after = record.lastDeliveredThroughOffset ?? afterOffset;
        record.lastDeliveredThroughOffset = throughOffset;
        this.#queuePushBehindInFlightDelivery(name, events, { after, through: throughOffset });
        continue;
      }
    }
  }

  /** A facet read waits for the processor pushes already queued to that exact local facet. */
  deliveriesQueuedFor(facetName: string): Promise<unknown> {
    return Promise.all(
      rowsPushingFacet(this.#stream.coreReducedState, facetName).map(
        (name) => this.#deliveryRecordByName.get(name)?.deliveryChain,
      ),
    );
  }

  #forgetSubscription(name: string): void {
    this.#deliveryRecordByName.delete(name);
  }

  async #catchUpFacetRow(name: string, row: Subscription): Promise<void> {
    const { head } = await this.#evaluateItxExpressionTargetHead(name, row.target);
    if (!this.#isStillTheRow(name, row)) return;
    if (!(head instanceof FacetHandle))
      throw codedError(
        "INVALID_INPUT",
        `subscription ${JSON.stringify(name)} processor target is not a processor facet`,
      );
    try {
      await this.#catchUpFacetFromLog(head, this.#causeAt(row.configuredAtOffset));
    } catch (error) {
      if (deterministicFailure(error)) {
        this.#haltRow(name, row.configuredAtOffset, row.configuredAtOffset, 1, error);
        return;
      }
      const code = errorCode(error);
      if (code === "FACET_ABORTED" || code === "FACET_RESTARTED")
        return await this.#catchUpFacetRow(name, row);
      throw error;
    }
  }

  /** Fold commits arriving behind one in-flight push into one bounded pending batch. */
  #queuePushBehindInFlightDelivery(name: string, events: StreamEvent[], range: ScannedRange): void {
    const record = this.#deliveryRecordFor(name);
    const pending = record.pendingPush;
    if (pending) {
      pending.chars = (pending.chars ?? serializedChars(pending.events)) + serializedChars(events);
      pending.events = pending.events.concat(events);
      pending.range.through = range.through;
      this.#dropPendingEventsOverTotalBudget();
      return;
    }
    record.pendingPush = { events, range, droppedEvents: 0 };
    record.deliveryChain = record.deliveryChain
      .then(async () => {
        const current = this.#deliveryRecordByName.get(name);
        const push = current?.pendingPush;
        if (current) current.pendingPush = undefined;
        const row = this.#subscription(name);
        if (!push || !row || row.halted) return;
        if (push.droppedEvents > 0)
          console.warn({
            event: "delivery.pending-push.dropped",
            namespace: "subscription-delivery",
            message: "a subscriber did not keep up: the oldest pending events were dropped",
            name,
            droppedEvents: push.droppedEvents,
            healFromOffset: push.range.after,
          });
        await this.#pushEventBatch(name, row, push.events, push.range);
      })
      .catch(() => undefined);
  }

  #dropOldestPendingEvents(pending: PendingPush, keepUnderChars: number): void {
    let dropCount = 0;
    while (pending.chars! > keepUnderChars && dropCount < pending.events.length - 1)
      pending.chars! -= JSON.stringify(pending.events[dropCount++]).length;
    if (dropCount === 0) return;
    pending.range.after = pending.events[dropCount - 1]!.offset;
    pending.events = pending.events.slice(dropCount);
    pending.droppedEvents += dropCount;
  }

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
      if (!this.#isStillTheRow(name, row)) return;
      const { head, call, pushesFacet } = await this.#evaluateTargetHeadForRow(name, row);
      if (!this.#isStillTheRow(name, row)) return;
      if (row.delivery === "live") {
        if (!(head instanceof RpcStubHandle))
          throw codedError(
            "INVALID_INPUT",
            `subscription ${JSON.stringify(name)} is configured for live delivery but its target is not a live provider`,
          );
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
      if (row.delivery !== "processor")
        throw codedError(
          "INVALID_INPUT",
          `subscription ${JSON.stringify(name)} has ${row.delivery} delivery but entered the push path`,
        );
      if (!(head instanceof FacetHandle) || !pushesFacet)
        throw codedError(
          "INVALID_INPUT",
          `subscription ${JSON.stringify(name)} is configured for processor delivery but its target is not a processor processEventBatch capability`,
        );
      // A PROCESSOR owns its checkpoint: push, AWAITED, so its batches stay in order. The DO's
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
        // A refusal that can only repeat halts the row instead of being re-pushed on every commit;
        // an operator's resume is the
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
      this.#reportFacetRowFailure("deliver", name, row, error);
    }
  }

  /** A facet row's delivery that failed: NO_FACET once the row is gone or replaced is the removal it
   *  raced — a disable, a delete, the facet taken with its row (`ctx.facets.delete` fails a call in
   *  flight, FacetHost `#call`) — an outcome, logged. A platform failure (`failureKind`: a hop's
   *  UNAVAILABLE, the facet call's own lost connection) is the platform's, logged
   *  `subscription-delivery.platform-failure-<action>` and not repeated here: a failure that stood is
   *  the caller's to wait out (docs/engineering-invariants.md#failures-and-retries), and the facet
   *  reads what it missed from the log at its next push (iterate/stream/processor.ts gap repair), as
   *  after a dropped push. Anything else is an issue. */
  #reportFacetRowFailure(
    action: "resume" | "configured" | "deliver" | "catch-up-after-timeout",
    name: string,
    row: Subscription,
    error: unknown,
  ): void {
    const failureSite = `subscription-delivery.${action}`;
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
    const kind = failureKind(error);
    if (isPlatformFailureKind(kind)) {
      logPlatformFailure("subscription-delivery", action, kind, { name, message: String(error) });
      return;
    }
    reportIssue(failureSite, error, { name });
  }

  /** The row under `name` is still the one configured at `row`'s offset — neither removed nor replaced. */
  #isStillTheRow(name: string, row: Subscription): boolean {
    return this.#subscription(name)?.configuredAtOffset === row.configuredAtOffset;
  }

  /** The catch-up a timed-out push owes (above), or one an `itx.facets.abort` cut off: chained, so
   *  it runs after this row's in-flight delivery and before anything queued later; a catch-up that
   *  fails is reported, never retried. */
  #catchUpAfterPushTimeout(name: string, row: Subscription): void {
    const record = this.#deliveryRecordFor(name);
    record.deliveryChain = record.deliveryChain.then(() =>
      this.#catchUpFacetRow(name, row).catch((error) =>
        this.#reportFacetRowFailure("catch-up-after-timeout", name, row, error),
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
    const current = this.#subscription(name);
    if (current?.configuredAtOffset !== configuredAtOffset || current.halted) return;
    // A halted row receives no further processor pushes until an operator resumes it.
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
      source: { cause: this.#causeAt(afterOffset + 1) },
    });
  }

  /** The cause of the durable event at `offset`: what a receipt of its delivery (a halt, a dead
   *  letter) is caused by (cause.ts). None when no durable event is there. */
  #causeAt(offset: number): Cause | undefined {
    return this.#stream.read(offset - 1, 1).events[0]?.source?.cause;
  }

  /** The memo of the evaluated target head (`evaluatedTargetHead` says what invalidates it). A
   *  target can move when a rewrite rule changes, so a cached head is reused only while the rule
   *  snapshot remains valid. */
  async #evaluateTargetHeadForRow(name: string, row: Subscription): Promise<EvaluatedTargetHead> {
    const rewriteRulesRef = this.#stream.coreReducedState.itxExpressionRewriteRules;
    const cached = this.#deliveryRecordByName.get(name)?.evaluatedTargetHead;
    if (
      cached &&
      cached.configuredAtOffset === row.configuredAtOffset &&
      cached.rewriteRulesRef === rewriteRulesRef &&
      Date.now() < cached.validUntil
    )
      return cached;
    const evaluated = await this.#evaluateItxExpressionTargetHead(name, row.target);
    // A row removed or replaced meanwhile gets its answer and nothing more: the memo, the cursor
    // and the fan-out state under `name` are the replacement's.
    if (!this.#isStillTheRow(name, row)) return evaluated;
    this.#deliveryRecordFor(name).evaluatedTargetHead = {
      configuredAtOffset: row.configuredAtOffset,
      rewriteRulesRef,
      ...evaluated,
    };
    return evaluated;
  }

  /** Evaluate a target's HEAD (everything but a trailing method name) and return the value plus the
   *  one call to make on it. A target ending in a call step names the callee itself (a bare lent
   *  callback: `itx.rpcStubs.get('k')`); a trailing property step names the method to call on it
   *  (`…get('presence').processEventBatch`) — on a facet, the facet host's push. */
  async #evaluateItxExpressionTargetHead(
    _name: string,
    target: ItxExpression,
  ): Promise<EvaluatedTargetHead> {
    // Resolve aliases before peeling the terminal platform method. With `itx.alias` pointing at
    // `itx.facets.get("p").processEventBatch`, peeling the raw two-step expression would invoke the
    // facet's public wall with no batch; the resolved fixed point exposes the actual facet head.
    const resolved = this.#resolveItxExpression?.(target).at(-1) ?? target;
    const last = resolved.at(-1);
    const method = typeof last === "string" && resolved.length > 2 ? last : undefined;
    const {
      value: head,
      validUntil,
      routedTo,
    } = await this.#evaluateItxExpression(method ? resolved.slice(0, -1) : resolved);
    // Every delivery below AWAITS this only for the ack and IGNORES the return. A Workers-RPC/capnweb
    // call result pins the callee's export table until disposed, so release it here — a live client's
    // push runs on every commit, and leaving each result to GC would leak a slot per delivered batch.
    const invoke = async (args: unknown[]): Promise<void> => {
      const walked = method
        ? (await walkSteps({ value: head, receiver: undefined }, [[method, ...args]])).value
        : await callOn(head, undefined, args);
      // A PIPELINED call answers with a branded promise the step walk hands back UNAWAITED
      // (context/dispatch.ts): settle it HERE, before the dispose — otherwise a sibling hop's refusal
      // (FORBIDDEN from the target context) or a hang was disposed unseen and the batch acked as
      // delivered. The settled value is what pins the callee, so that is what is released.
      const result = await walked;
      if (typeof result === "object" && result && Symbol.dispose in result)
        (result as Disposable)[Symbol.dispose]();
    };
    const call = async (events: StreamEvent[], range: ScannedRange): Promise<void> => {
      if (head instanceof FacetHandle && method === "processEventBatch") {
        await this.#pushEventBatchToFacet(head, events, range);
        return;
      }
      await invoke([events, range]);
    };
    // Only the one call that carries the log's own event runs with delivery authority: evaluating
    // the head above never does, so a target spelling `deliverEvent(<its own event>)` is refused.
    return {
      head,
      validUntil,
      routedTo,
      call,
      pushesFacet: head instanceof FacetHandle && method === "processEventBatch",
    };
  }
}
