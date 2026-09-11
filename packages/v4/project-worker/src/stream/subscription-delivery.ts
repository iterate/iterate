// Serializes one delivery chain per subscription. Handles own their progress; every other target
// is driven from the durable cursor below. Cursor calls are their acknowledgement.

import type { ItxExpression } from "../context/expression.ts";
import { callOn, walkSteps } from "../context/dispatch.ts";
import { FacetHandle, RpcStubHandle } from "../context/invoke-handle.ts";
import { errorCode, reportIssue } from "../lib/errors.ts";
import { withTimeout } from "../lib/timeout.ts";
import type { StreamEvent } from "./events.ts";
import { consumesEvent, type ScannedRange } from "./processor.ts";
import type { Subscription } from "./core-processor.ts";
import type { Stream } from "./stream.ts";
import type { SubscriptionCursor } from "./stream-storage.ts";

const CALL_WATCHDOG_MS = 20_000;
const MAX_PENDING_CHARS = 8 * 1024 * 1024;
const MAX_TOTAL_PENDING_CHARS = 16 * 1024 * 1024;
const MAX_IN_FLIGHT_CHARS = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 15;

type PendingPush = {
  events: StreamEvent[];
  range: ScannedRange;
  chars?: number;
  droppedEvents: number;
};
type Target = { head: unknown; call: (args: unknown[]) => Promise<unknown> };
type CachedTarget = Target & { configuredAtOffset: number; rewriteRulesRef: object };
type CursorTarget = Pick<Target, "call"> & { forRowConfiguredAtOffset: number };

const chars = (events: StreamEvent[]) =>
  events.reduce((total, event) => total + JSON.stringify(event).length, 0);
// Workerd and our checkpoint path may stamp a foreign Error with this optional refusal marker.
const cannotRetry = (error: unknown) =>
  (error as { retryable?: unknown } | null)?.retryable === false ||
  [
    "NOT_A_METHOD",
    "NO_ITX_EXPRESSION_MATCH",
    "REDUCE_CHECKPOINT_TOO_LARGE",
    "EVENT_TOO_LARGE",
  ].includes(errorCode(error) ?? "");

export class SubscriptionDelivery {
  readonly #stream: Stream;
  readonly #evaluate: (expression: ItxExpression) => Promise<unknown>;
  readonly #recordActivity: () => void;
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #pending = new Map<string, PendingPush>();
  readonly #lastThrough = new Map<string, number>();
  readonly #pushed = new Map<string, { events: StreamEvent[]; after: number; through: number }>();
  readonly #cursors = new Map<string, SubscriptionCursor>();
  readonly #pushRows = new Set<string>();
  readonly #runningCursors = new Set<string>();
  readonly #targetCache = new Map<string, CachedTarget>();
  /** A push and a catch-up can observe the same refusal concurrently; append one halt fact. */
  readonly #halting = new Map<string, Promise<void>>();
  readonly #roomWaiters: (() => void)[] = [];
  #inFlightChars = 0;

  constructor({
    stream,
    evaluateItxExpression,
    recordActivityForQuietClock,
  }: {
    stream: Stream;
    evaluateItxExpression: (expression: ItxExpression) => Promise<unknown>;
    recordActivityForQuietClock: () => void;
  }) {
    this.#stream = stream;
    this.#evaluate = evaluateItxExpression;
    this.#recordActivity = recordActivityForQuietClock;
    for (const [name, cursor] of stream.storage.listSubscriptionCursors())
      this.#cursors.set(name, cursor);
  }

  onCommit(events: StreamEvent[], after: number, through: number): void {
    this.#handleControlEvents(events);
    for (const [name, row] of Object.entries(this.#stream.coreReducedState.subscriptions)) {
      if (row.halted) continue;
      const consumed = events.filter((event) => consumesEvent(row.consumes, event));
      if (consumed.length === 0) continue;
      const range = { after: this.#lastThrough.get(name) ?? after, through };
      this.#lastThrough.set(name, through);
      if (!this.#pushRows.has(name)) {
        this.#pushed.set(name, { events: consumed, ...range });
        this.#stream.armAlarmNoLaterThan(Date.now() + CALL_WATCHDOG_MS);
      }
      this.#queue(name, consumed, range);
    }
  }

  #handleControlEvents(events: StreamEvent[]): void {
    const rows = this.#stream.coreReducedState.subscriptions;
    for (const event of events) {
      if (event.type === "events.iterate.com/stream/subscription-delivery-resumed") {
        const name = (event.payload as { name: string }).name;
        const row = rows[name];
        if (!row) continue;
        const deliver = this.#pushRows.has(name)
          ? this.#catchUpFacet(name, row)
          : this.#deliverCursor(name);
        void deliver.catch((error) => reportIssue("subscription-delivery.resume", error, { name }));
      }
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        const name = (event.payload as { name: string }).name;
        this.#forget(name);
        const row = rows[name];
        if (!row) continue;
        this.#chains.set(
          name,
          this.#catchUpFacet(name, row).catch((error) => {
            if (errorCode(error) !== "NO_FACET")
              reportIssue("subscription-delivery.configured", error, { name });
          }),
        );
      }
    }
  }

  async #catchUpFacet(name: string, row: Subscription): Promise<void> {
    const { head } = await this.#evaluateTarget(row.target);
    if (!(head instanceof FacetHandle) || !this.#isCurrentActiveRow(name, row.configuredAtOffset))
      return;
    try {
      await head.invoke([["catchUpFromLog"]]);
    } catch (error) {
      if (
        await this.#haltDeterministic(name, row.configuredAtOffset, row.configuredAtOffset, error)
      )
        return;
      throw error;
    }
  }

  #queue(name: string, events: StreamEvent[], range: ScannedRange): void {
    const waiting = this.#pending.get(name);
    if (waiting) {
      waiting.chars = (waiting.chars ?? chars(waiting.events)) + chars(events);
      waiting.events = waiting.events.concat(events);
      waiting.range.through = range.through;
      this.#trim(waiting, MAX_PENDING_CHARS);
      this.#trimTotal();
      return;
    }
    this.#pending.set(name, { events, range, droppedEvents: 0 });
    const chain = (this.#chains.get(name) ?? Promise.resolve()).then(async () => {
      const push = this.#pending.get(name);
      this.#pending.delete(name);
      const row = this.#stream.coreReducedState.subscriptions[name];
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
      await this.#deliver(name, row, push.events, push.range);
    });
    this.#chains.set(
      name,
      chain.catch(() => undefined),
    );
  }

  #trim(push: PendingPush, limit: number): void {
    let count = 0;
    while (push.chars! > limit && count < push.events.length - 1)
      push.chars! -= JSON.stringify(push.events[count++]).length;
    if (count === 0) return;
    push.range.after = push.events[count - 1].offset;
    push.events = push.events.slice(count);
    push.droppedEvents += count;
  }

  #trimTotal(): void {
    for (;;) {
      let total = 0;
      let largest: PendingPush | undefined;
      for (const push of this.#pending.values()) {
        if (push.chars === undefined) continue;
        total += push.chars;
        if (push.events.length > 1 && (!largest || push.chars > largest.chars!)) largest = push;
      }
      const excess = total - MAX_TOTAL_PENDING_CHARS;
      if (excess <= 0 || !largest) return;
      this.#trim(largest, largest.chars! - excess);
    }
  }

  async #withRoom<T>(size: number, work: () => Promise<T>): Promise<T> {
    while (this.#inFlightChars > 0 && this.#inFlightChars + size > MAX_IN_FLIGHT_CHARS)
      await new Promise<void>((resolve) => this.#roomWaiters.push(resolve));
    this.#inFlightChars += size;
    try {
      return await work();
    } finally {
      this.#inFlightChars -= size;
      for (const wake of this.#roomWaiters.splice(0)) wake();
    }
  }

  async deliverEveryCursorSubscription(maxThrough?: () => number | undefined): Promise<void> {
    await Promise.all(
      Object.keys(this.#stream.coreReducedState.subscriptions)
        .filter((name) => !this.#pushRows.has(name))
        .map((name) =>
          this.#deliverCursor(name, undefined, maxThrough).catch((error) =>
            reportIssue("subscription-delivery.cursor", error, { name }),
          ),
        ),
    );
  }

  cursor(name: string): SubscriptionCursor | undefined {
    return this.#cursors.get(name);
  }

  #forget(name: string): void {
    this.#cursors.delete(name);
    this.#stream.storage.deleteSubscriptionCursor(name);
    this.#targetCache.delete(name);
    this.#pushRows.delete(name);
    this.#chains.delete(name);
    this.#pending.delete(name);
    this.#lastThrough.delete(name);
    this.#pushed.delete(name);
  }

  #setCursor(name: string, cursor: SubscriptionCursor, persist: boolean): void {
    this.#cursors.set(name, cursor);
    if (persist) this.#stream.storage.writeSubscriptionCursor(name, cursor);
  }

  #dropCursor(name: string): void {
    this.#cursors.delete(name);
    this.#stream.storage.deleteSubscriptionCursor(name);
  }

  async #deliver(
    name: string,
    row: Subscription,
    events: StreamEvent[],
    range: ScannedRange,
  ): Promise<void> {
    try {
      if (!this.#isCurrentActiveRow(name, row.configuredAtOffset)) return;
      const target = await this.#targetForRow(name, row);
      if (!this.#isCurrentActiveRow(name, row.configuredAtOffset)) return;
      if (target.head instanceof FacetHandle || target.head instanceof RpcStubHandle)
        this.#pushRows.add(name);
      if (target.head instanceof RpcStubHandle)
        return this.#pushStub(name, target.call, events, range);
      if (target.head instanceof FacetHandle)
        return await this.#pushFacet(name, row, target.call, events, range);
      await this.#deliverCursor(name, {
        call: target.call,
        forRowConfiguredAtOffset: row.configuredAtOffset,
      });
    } catch (error) {
      if (errorCode(error) !== "NO_FACET")
        reportIssue("subscription-delivery.deliver", error, { name });
    } finally {
      this.#recordActivity();
    }
  }

  #pushStub(name: string, call: Target["call"], events: StreamEvent[], range: ScannedRange): void {
    this.#pushed.delete(name);
    const size = chars(events);
    if (this.#inFlightChars + size > MAX_IN_FLIGHT_CHARS) {
      console.warn({
        event: "delivery.push.dropped",
        namespace: "subscription-delivery",
        message:
          "push delivery dropped: the context's in-flight budget is full (the subscriber heals by read)",
        name,
        healFromOffset: range.after,
        inFlightChars: this.#inFlightChars,
      });
      return;
    }
    this.#inFlightChars += size;
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
      .finally(() => {
        this.#inFlightChars -= size;
        for (const wake of this.#roomWaiters.splice(0)) wake();
      });
  }

  async #pushFacet(
    name: string,
    row: Subscription,
    call: Target["call"],
    events: StreamEvent[],
    range: ScannedRange,
  ): Promise<void> {
    this.#pushed.delete(name);
    try {
      await this.#withRoom(chars(events), () => call([events, range]));
    } catch (error) {
      if (await this.#haltDeterministic(name, row.configuredAtOffset, range.after, error)) return;
      throw error;
    }
  }

  #isCurrentActiveRow(name: string, configuredAtOffset: number): boolean {
    const row = this.#stream.coreReducedState.subscriptions[name];
    return row?.configuredAtOffset === configuredAtOffset && !row.halted;
  }

  /**
   * A facet owns its cursor, so a refusal that its own checkpoint has latched cannot be repaired by
   * a stream-side retry. Record that terminal outcome once, including when the concurrently queued
   * push or a resume catch-up sees the same error. Unknown failures still reject to their caller.
   */
  async #haltDeterministic(
    name: string,
    configuredAtOffset: number,
    afterOffset: number,
    error: unknown,
  ): Promise<boolean> {
    if (!cannotRetry(error)) return false;
    const current = this.#stream.coreReducedState.subscriptions[name];
    // An old configuration must not hide an error from a different current row. The same current
    // configuration, however, has already made its terminal outcome durable.
    if (current?.configuredAtOffset !== configuredAtOffset) return false;
    if (current.halted) return true;
    const alreadyHalting = this.#halting.get(name);
    if (alreadyHalting) {
      await alreadyHalting;
      return true;
    }
    const halt = (async () => {
      // A competing completion may have appended the fact while this turn yielded.
      if (!this.#isCurrentActiveRow(name, configuredAtOffset)) return;
      await this.#halt(name, afterOffset, 1, error);
    })();
    this.#halting.set(name, halt);
    try {
      await halt;
      return true;
    } finally {
      if (this.#halting.get(name) === halt) this.#halting.delete(name);
    }
  }

  async #targetForRow(name: string, row: Subscription): Promise<Target> {
    const rewriteRulesRef = this.#stream.coreReducedState.itxExpressionRewriteRules;
    const cached = this.#targetCache.get(name);
    if (
      cached &&
      cached.configuredAtOffset === row.configuredAtOffset &&
      cached.rewriteRulesRef === rewriteRulesRef
    )
      return cached;
    const target = await this.#evaluateTarget(row.target);
    this.#targetCache.set(name, {
      ...target,
      configuredAtOffset: row.configuredAtOffset,
      rewriteRulesRef,
    });
    return target;
  }

  async #evaluateTarget(expression: ItxExpression): Promise<Target> {
    const last = expression.at(-1);
    const method = typeof last === "string" && expression.length > 2 ? last : undefined;
    const head = await this.#evaluate(method ? expression.slice(0, -1) : expression);
    const call = async (args: unknown[]) =>
      method
        ? (await walkSteps({ value: head, receiver: undefined }, [[method, ...args]])).value
        : callOn(head, undefined, args);
    return { head, call };
  }

  async #deliverCursor(
    name: string,
    target?: CursorTarget,
    maxThrough?: () => number | undefined,
  ): Promise<void> {
    if (this.#runningCursors.has(name)) return;
    this.#runningCursors.add(name);
    try {
      for (;;) {
        const row = this.#stream.coreReducedState.subscriptions[name];
        if (!row) return this.#forget(name);
        let cursor = this.#cursors.get(name) ?? {
          confirmedOffset: row.configuredAtOffset,
          attempt: 0,
        };
        if (!this.#cursors.has(name)) this.#setCursor(name, cursor, false);
        if (row.resumed && row.resumed.atOffset !== cursor.resumeAppliedAtOffset) {
          cursor = {
            confirmedOffset: Math.min(
              row.resumed.afterOffset ?? cursor.confirmedOffset,
              this.#stream.highestDurableOffset(),
            ),
            attempt: 0,
            resumeAppliedAtOffset: row.resumed.atOffset,
          };
          this.#setCursor(name, cursor, true);
        }
        if (row.halted) return;
        if (cursor.nextAttemptAtMs !== undefined && Date.now() < cursor.nextAttemptAtMs) {
          this.#stream.armAlarmNoLaterThan(cursor.nextAttemptAtMs);
          return;
        }
        const batch = this.#nextBatch(name, row, cursor, maxThrough?.());
        if (!batch) return;
        const range = { after: cursor.confirmedOffset, through: batch.through };
        const durable = batch.events.some((event) => !event.ephemeral);
        if (batch.events.length === 0) {
          this.#setCursor(name, { ...cursor, confirmedOffset: range.through }, true);
          continue;
        }
        try {
          const resolvedTarget = await this.#cursorTarget(name, row, target);
          if (resolvedTarget === undefined) continue;
          if (resolvedTarget === null) return;
          target = resolvedTarget;
          this.#stream.armAlarmNoLaterThan(Date.now() + CALL_WATCHDOG_MS);
          await this.#withRoom(chars(batch.events), () =>
            withTimeout(
              resolvedTarget.call([batch.events, range]),
              CALL_WATCHDOG_MS,
              `subscription "${name}"`,
            ),
          );
          if (!this.#cursors.has(name)) continue;
          this.#setCursor(
            name,
            {
              confirmedOffset: range.through,
              attempt: 0,
              resumeAppliedAtOffset: cursor.resumeAppliedAtOffset,
            },
            durable,
          );
          this.#recordActivity();
        } catch (error) {
          if (!this.#cursors.has(name)) continue;
          const latest = this.#stream.coreReducedState.subscriptions[name];
          if (latest?.resumed && latest.resumed.atOffset !== cursor.resumeAppliedAtOffset) continue;
          await this.#retryOrHalt(name, cursor, error);
          return;
        }
      }
    } finally {
      this.#runningCursors.delete(name);
    }
  }

  #nextBatch(
    name: string,
    row: Subscription,
    cursor: SubscriptionCursor,
    maxThrough?: number,
  ): { events: StreamEvent[]; through: number } | undefined {
    let pushed = this.#pushed.get(name);
    if (pushed && pushed.after < cursor.confirmedOffset) {
      this.#pushed.delete(name);
      pushed = undefined;
    }
    if (pushed?.after === cursor.confirmedOffset) {
      const through = Math.min(pushed.through, maxThrough ?? pushed.through);
      if (through <= cursor.confirmedOffset) return undefined;
      const events = pushed.events.filter((event) => event.offset <= through);
      if (through === pushed.through) this.#pushed.delete(name);
      else {
        pushed.events = pushed.events.filter((event) => event.offset > through);
        pushed.after = through;
      }
      return { events, through };
    }
    const page = this.#stream.read(cursor.confirmedOffset, 100);
    const through = Math.min(
      pushed ? Math.min(page.scannedThroughOffset, pushed.after) : page.scannedThroughOffset,
      maxThrough ?? Number.POSITIVE_INFINITY,
    );
    if (through <= cursor.confirmedOffset) return undefined;
    return {
      events: page.events.filter(
        (event) => event.offset <= through && consumesEvent(row.consumes, event),
      ),
      through,
    };
  }

  async #cursorTarget(
    name: string,
    row: Subscription,
    target?: CursorTarget,
  ): Promise<CursorTarget | null | undefined> {
    if (target?.forRowConfiguredAtOffset === row.configuredAtOffset) return target;
    const evaluated = await this.#evaluateTarget(row.target);
    if (evaluated.head instanceof FacetHandle || evaluated.head instanceof RpcStubHandle) {
      this.#pushRows.add(name);
      this.#dropCursor(name);
      return null;
    }
    if (!this.#cursors.has(name)) return undefined;
    return { call: evaluated.call, forRowConfiguredAtOffset: row.configuredAtOffset };
  }

  async #retryOrHalt(name: string, cursor: SubscriptionCursor, error: unknown): Promise<void> {
    const attempt = cursor.attempt + 1;
    if (cannotRetry(error) || attempt >= MAX_ATTEMPTS)
      return this.#halt(name, cursor.confirmedOffset, attempt, error);
    const delay = Math.min(1000 * 2 ** (attempt - 1), 1_800_000) * (0.8 + Math.random() * 0.4);
    const nextAttemptAtMs = Date.now() + Math.round(delay);
    this.#setCursor(name, { ...cursor, attempt, nextAttemptAtMs }, true);
    this.#stream.armAlarmNoLaterThan(nextAttemptAtMs);
  }

  async #halt(name: string, afterOffset: number, attempts: number, error: unknown): Promise<void> {
    const cursor = this.#cursors.get(name);
    if (cursor) this.#setCursor(name, { ...cursor, attempt: 0 }, true);
    this.#stream.appendSystem({
      type: "events.iterate.com/stream/subscription-delivery-halted",
      payload: {
        name,
        afterOffset,
        attempts,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
      },
    });
  }
}
