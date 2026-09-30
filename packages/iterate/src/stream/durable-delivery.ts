// stream/durable-delivery.ts — the context-owned durable delivery runner. It retains a bounded
// scanned range plus selected offsets and asks its host to invoke the configured expression under
// ordinary delivery authority.

import { errorCode } from "../lib.ts";
import { consumesEvent, type EngineKv, type ScannedRange, type StreamEvent } from "./processor.ts";

export type DurableDeliveryCursor = {
  confirmedOffset: number;
  pending?: {
    after: number;
    through: number;
    /** Selected durable event offsets for this scanned range. They make retries body-free. */
    offsets: number[];
    attempt: number;
    nextAttemptAtMs?: number;
    error?: string;
    resumeAtOffset?: number;
  };
  halted?: {
    after: number;
    attempts: number;
    error: string;
    terminalReported?: true;
    resumeAtOffset?: number;
  };
  fanOut?: { admittedThrough: number; pending: FanOutPending[] };
};

type FanOutPending = {
  offset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  error?: string;
  /** Resume control identity captured before the target call begins. */
  resumeAtOffset?: number;
  terminal?: true;
};

export type DurableDeliveryRuntime = {
  storage: EngineKv;
  read(
    afterOffset: number,
    limit: number,
    resumeAtOffset?: number,
  ): Promise<{
    offsets: number[];
    scannedThroughOffset: number;
    atHead: boolean;
  }>;
  /** Re-read and invoke the stored durable target under Caller.delivery. */
  deliver(input: {
    range: ScannedRange;
    offsets: number[];
    /** Resume control identity captured before this call began. */
    resumeAtOffset?: number;
  }): Promise<void>;
  /** Re-read one ephemeral from the current context's live ring. */
  deliverEphemeral(input: { offset: number; type: string; resumeAtOffset?: number }): Promise<void>;
  scheduleWake(atMs: number | null): Promise<void>;
  terminal(input: {
    afterOffset: number;
    attempts: number;
    error: string;
    fanOut?: true;
    resumeAtOffset?: number;
  }): Promise<void>;
};

export type DurableDeliveryOptions = {
  slug: string;
  /** Omitted has the normal subscription meaning: every durable event. */
  consumes?: readonly string[];
  runtime: DurableDeliveryRuntime;
  afterOffset?: number;
  /** The current resume control fact; terminal reports are ignored if this changes. */
  resumeAtOffset?: number;
  maxAttempts?: number;
  /** One event per call with independent progress; absent preserves ordered batches. */
  fanOut?: true;
  concurrency?: number;
  maxPending?: number;
  retryDelayMs?: (attempt: number) => number;
  /** Bounds one invoke; the host aborts its facet instead of overlapping an unsettled call. */
  callDeadlineMs?: number;
};

const pageLimit = 100;
const defaultCallDeadlineMs = 20_000;
// The context's 1 MiB live ring owns ephemeral bodies. Keep only enough descriptors for one
// ordinary source page here, so a push storm cannot build an unbounded scheduling queue.
const ephemeralQueueLimit = pageLimit;

// A native target already has this row's body. Do not spend a delivery attempt, but avoid turning
// a wedged target into a hot alarm loop while its native completion wake is unavailable.
const busyRetryDelayMs = 1_000;
const deliveryErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
const deliveryBusy = (error: unknown): boolean =>
  errorCode(error) === "UNAVAILABLE" &&
  typeof error === "object" &&
  !!error &&
  "data" in error &&
  typeof (error as { data?: unknown }).data === "object" &&
  (error as { data?: { deliveryBusy?: unknown } }).data?.deliveryBusy === true;

/** A resume fact can reach the context while the old facet invocation is in flight. The context
 * fences that invocation with this private marker; it is neither a target failure nor an attempt. */
const staleResume = (error: unknown, resumeAtOffset: number | undefined): boolean => {
  if (errorCode(error) !== "GONE" || typeof error !== "object" || !error || !("data" in error))
    return false;
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    !!data &&
    "resumeAtOffset" in data &&
    (data as { resumeAtOffset?: unknown }).resumeAtOffset !== resumeAtOffset
  );
};

const permanentFailure = (error: unknown): boolean =>
  [
    "PERMANENT_FAILURE",
    "GONE",
    "NOT_A_METHOD",
    "REDUCE_CHECKPOINT_TOO_LARGE",
    "EVENT_TOO_LARGE",
    "FORBIDDEN",
    "LOOP_LIMIT",
  ].includes(errorCode(error) ?? "");

/** A refusal to construct the configured target belongs to the row, rather than to one event.
 * A receiver's own `PERMANENT_FAILURE` remains a per-event fan-out outcome. */
const configuredTargetFailure = (error: unknown): boolean =>
  ["NOT_A_METHOD", "FORBIDDEN", "GONE"].includes(errorCode(error) ?? "");

/** Cursor state shares a KV cell with up to one thousand fan-out failures. */
const deliveryErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1024);

/** The SDK replacement for one durable `subscribe` row. It stores only a cursor plus at most one
 * pending scanned range; source bodies stay in the event log and are read again for every attempt. */
export class DurableDeliveryProcessor {
  readonly #options: Required<
    Pick<DurableDeliveryOptions, "maxAttempts" | "concurrency" | "maxPending" | "callDeadlineMs">
  > &
    DurableDeliveryOptions;
  #requested = false;
  #again = false;
  #disposed = false;
  #resumeAtOffset: number | undefined;
  #generation = 0;
  #ephemeralQueue: { offset: number; type: string; resumeAtOffset: number | undefined }[] = [];

  constructor(options: DurableDeliveryOptions) {
    if (!options.slug) throw new Error("durable delivery needs slug");
    const maxAttempts = options.maxAttempts ?? 15;
    const concurrency = options.concurrency ?? 8;
    const maxPending = options.maxPending ?? 1_000;
    const callDeadlineMs = options.callDeadlineMs ?? defaultCallDeadlineMs;
    if (
      ![maxAttempts, concurrency, maxPending, callDeadlineMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error("durable delivery limits must be positive finite integers");
    this.#options = { ...options, maxAttempts, concurrency, maxPending, callDeadlineMs };
    this.#resumeAtOffset = options.resumeAtOffset;
  }

  /** Records one pushed ephemeral. Durable work is discovered from the source when `drive` runs. */
  push(event?: StreamEvent): void {
    if (this.#disposed) return;
    // Ephemerals are intentionally best effort: the push carries their only body, and no KV write
    // turns them into durable work. A restart before this call begins loses them as it does today.
    if (!this.#options.fanOut && event?.ephemeral && consumesEvent(this.#options.consumes, event))
      this.#queueEphemeral(event);
  }

  #queueEphemeral(event: StreamEvent): void {
    const cursor = this.#cursor();
    // A durable range already owns this position. Do not roll it back to insert a best-effort
    // live event after an asynchronous push arrives.
    if (
      event.offset <= cursor.confirmedOffset ||
      (cursor.pending !== undefined && event.offset <= cursor.pending.through)
    ) {
      console.warn({
        event: "durable-delivery.ephemeral-overtaken",
        slug: this.#options.slug,
        offset: event.offset,
      });
      return;
    }
    if (this.#ephemeralQueue.some((pending) => pending.offset === event.offset)) return;
    while (this.#ephemeralQueue.length >= ephemeralQueueLimit) {
      const dropped = this.#ephemeralQueue.shift()!;
      console.warn({
        event: "durable-delivery.ephemeral-dropped",
        slug: this.#options.slug,
        offset: dropped.offset,
        reason: "queue-full",
      });
    }
    this.#ephemeralQueue.push({
      offset: event.offset,
      type: event.type,
      resumeAtOffset: this.#resumeAtOffset,
    });
    this.#ephemeralQueue.sort((a, b) => a.offset - b.offset);
  }

  #discardEphemerals(): void {
    this.#ephemeralQueue.length = 0;
  }

  /** Releases bodies held only by this runner when its configured row is replaced. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    this.#again = false;
    this.#discardEphemerals();
  }

  /** The context calls this after configuration and revive. It shares the normal processor
   * background/claim path without exposing a second delivery API to authors. */
  drive(runInBackground: (work: () => Promise<unknown>) => void): void {
    if (this.#disposed) return;
    this.#requestDrain(runInBackground);
  }

  /** The subscriptions facet applies the existing resume control fact before calling drive. */
  resume(afterOffset?: number, offset?: number, resumeAtOffset?: number): boolean {
    if (this.#disposed) return false;
    const cursor = this.#cursor();
    const fanOut =
      (this.#options.fanOut && afterOffset !== undefined
        ? { admittedThrough: afterOffset, pending: [] }
        : cursor.fanOut) ||
      (this.#options.fanOut && offset !== undefined
        ? { admittedThrough: afterOffset ?? cursor.confirmedOffset, pending: [] }
        : undefined);
    if (fanOut) {
      this.#resumeAtOffset = resumeAtOffset;
      this.#generation++;
      const rowWasHalted = !!cursor.halted;
      const pending = fanOut.pending.map((item) =>
        rowWasHalted || (item.terminal && (offset === undefined || item.offset === offset))
          ? {
              ...item,
              terminal: undefined,
              attempt: 0,
              nextAttemptAtMs: undefined,
              resumeAtOffset: this.#resumeAtOffset,
            }
          : item,
      );
      // A terminal receipt is removed after the host acknowledges its dead-letter fact, so a
      // selective operator resume recreates that one item even after a cold revive. Its offset is
      // below admittedThrough and therefore cannot be rediscovered by normal admission.
      if (offset !== undefined && !pending.some((item) => item.offset === offset))
        pending.push({ offset, attempt: 0, resumeAtOffset: this.#resumeAtOffset });
      const { halted: _halted, ...running } = cursor;
      this.#putCursor({ ...running, fanOut: { ...fanOut, pending } });
      return true;
    }
    this.#resumeAtOffset = resumeAtOffset;
    this.#generation++;
    this.#putCursor({
      confirmedOffset: afterOffset ?? cursor.halted?.after ?? cursor.confirmedOffset,
    });
    return true;
  }

  /** Core already recorded this row's terminal receipt. Invalidate any older call before replacing
   * local progress so its late result cannot overwrite the receipt or schedule a wake. */
  halt(afterOffset: number, attempts: number, error: string, resumeAtOffset?: number): boolean {
    if (this.#disposed) return false;
    const cursor = this.#cursor();
    const halted = cursor.halted;
    const message = deliveryErrorMessage(error);
    if (
      halted?.after === afterOffset &&
      halted.attempts === attempts &&
      halted.error === message &&
      halted.resumeAtOffset === resumeAtOffset &&
      halted.terminalReported
    )
      return false;
    this.#generation++;
    this.#resumeAtOffset = resumeAtOffset;
    this.#discardEphemerals();
    this.#putCursor({
      confirmedOffset: afterOffset,
      fanOut: cursor.fanOut,
      halted: {
        after: afterOffset,
        attempts,
        error: message,
        terminalReported: true,
        resumeAtOffset,
      },
    });
    return true;
  }

  /** Operational progress for subscriptions.list; a copy contains offsets and attempts, never event bodies. */
  snapshot(): DurableDeliveryCursor {
    return structuredClone(this.#cursor());
  }

  #key() {
    return `durable-delivery/${this.#options.slug}`;
  }
  #cursor(): DurableDeliveryCursor {
    return (
      this.#options.runtime.storage.get<DurableDeliveryCursor>(this.#key()) ?? {
        confirmedOffset: this.#options.afterOffset ?? 0,
      }
    );
  }
  #putCursor(cursor: DurableDeliveryCursor): void {
    this.#options.runtime.storage.put(this.#key(), cursor);
  }

  #requestDrain(runInBackground: (work: () => Promise<unknown>) => void): void {
    if (this.#disposed) return;
    if (this.#requested) {
      this.#again = true;
      return;
    }
    this.#requested = true;
    runInBackground(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      try {
        await this.#drain();
      } finally {
        this.#requested = false;
        if (!this.#disposed && this.#again) {
          this.#again = false;
          void this.#requestDrain(runInBackground);
        }
      }
    });
  }

  async #drain(): Promise<void> {
    if (this.#disposed) return;
    if (this.#options.fanOut) return await this.#drainFanOut();
    for (;;) {
      let cursor = this.#cursor();
      if (cursor.halted) {
        await this.#reportHalted(cursor.halted);
        return;
      }
      if (cursor.pending?.nextAttemptAtMs && cursor.pending.nextAttemptAtMs > Date.now()) {
        await this.#options.runtime.scheduleWake(cursor.pending.nextAttemptAtMs);
        return;
      }
      if (!cursor.pending) {
        const stamp = this.#stamp();
        let page: Awaited<ReturnType<DurableDeliveryRuntime["read"]>>;
        try {
          page = await this.#options.runtime.read(
            cursor.confirmedOffset,
            pageLimit,
            stamp.resumeAtOffset,
          );
        } catch {
          if (this.#isCurrent(stamp))
            await this.#options.runtime.scheduleWake(Date.now() + busyRetryDelayMs);
          return;
        }
        {
          if (!this.#isCurrent(stamp)) return;
          cursor = this.#cursor();
          if (cursor.pending || cursor.halted) continue;
          const queuedOffset = this.#ephemeralQueue[0]?.offset;
          // An ephemeral between two durable offsets stays between their deliveries. The durable
          // read does not carry ephemeral bodies, so admit only the durable prefix before it.
          const through =
            queuedOffset !== undefined && queuedOffset <= page.scannedThroughOffset
              ? Math.min(page.scannedThroughOffset, queuedOffset - 1)
              : page.scannedThroughOffset;
          if (through <= cursor.confirmedOffset) {
            if (this.#ephemeralQueue.length === 0) {
              await this.#options.runtime.scheduleWake(null);
              return;
            }
            await this.#drainEphemerals();
            if (!this.#isCurrent(stamp)) return;
            continue;
          }
          const offsets = page.offsets.filter((offset) => offset <= through);
          if (offsets.length === 0) {
            this.#putCursor({ confirmedOffset: through });
            continue;
          }
          const pending = {
            after: cursor.confirmedOffset,
            through,
            offsets,
            attempt: 0,
            resumeAtOffset: stamp.resumeAtOffset,
          };
          cursor = {
            ...cursor,
            pending,
          };
          this.#putCursor(cursor);
        }
      }
      const pending = cursor.pending!;
      const stamp = this.#stamp();
      {
        if (!this.#isCurrent(stamp) || !this.#isCurrentPending(pending, pending.attempt)) return;
        const attempt = Math.min(pending.attempt + 1, this.#options.maxAttempts);
        this.#putCursor({
          ...this.#cursor(),
          pending: {
            ...pending,
            attempt,
            nextAttemptAtMs: Date.now() + this.#options.callDeadlineMs,
            resumeAtOffset: stamp.resumeAtOffset,
          },
        });
        try {
          if (pending.attempt >= this.#options.maxAttempts)
            throw new Error(pending.error ?? "delivery did not settle before its host restarted");
          await this.#deliverWithinDeadline({
            range: { after: pending.after, through: pending.through },
            offsets: pending.offsets,
            resumeAtOffset: stamp.resumeAtOffset,
          });
          if (!this.#isCurrent(stamp) || !this.#isCurrentPending(pending, attempt)) return;
          this.#putCursor({ confirmedOffset: pending.through });
        } catch (error) {
          if (!this.#isCurrent(stamp) || !this.#isCurrentPending(pending, attempt)) return;
          // The host has an equivalent target call in flight. It has not accepted
          // this attempt, so retain the prior attempt count and try after the
          // short native admission delay.
          if (deliveryBusy(error) || staleResume(error, stamp.resumeAtOffset)) {
            const nextAttemptAtMs = Date.now() + busyRetryDelayMs;
            this.#putCursor({
              ...this.#cursor(),
              pending: {
                ...pending,
                nextAttemptAtMs,
                resumeAtOffset: stamp.resumeAtOffset,
              },
            });
            await this.#options.runtime.scheduleWake(nextAttemptAtMs);
            return;
          }
          const message = deliveryErrorMessage(error);
          if (permanentFailure(error) || attempt >= this.#options.maxAttempts) {
            const halted = {
              after: pending.after,
              attempts: attempt,
              error: message,
              resumeAtOffset: stamp.resumeAtOffset,
            };
            this.#putCursor({ confirmedOffset: pending.after, halted });
            try {
              await this.#options.runtime.terminal({
                afterOffset: pending.after,
                attempts: attempt,
                error: message,
                resumeAtOffset: stamp.resumeAtOffset,
              });
              const current = this.#cursor().halted;
              if (
                this.#isCurrent(stamp) &&
                current?.after === halted.after &&
                current.attempts === halted.attempts &&
                current.resumeAtOffset === halted.resumeAtOffset
              )
                this.#putCursor({
                  ...this.#cursor(),
                  halted: { ...current, terminalReported: true },
                });
            } catch {
              if (this.#isCurrent(stamp))
                await this.#options.runtime.scheduleWake(Date.now() + 1_000);
            }
            return;
          }
          const nextAttemptAtMs =
            Date.now() +
            (this.#options.retryDelayMs || ((n) => Math.min(1_000 * 2 ** (n - 1), 30 * 60_000)))(
              attempt,
            );
          this.#putCursor({
            ...this.#cursor(),
            pending: {
              ...pending,
              attempt,
              nextAttemptAtMs,
              error: message,
              resumeAtOffset: stamp.resumeAtOffset,
            },
          });
          await this.#options.runtime.scheduleWake(nextAttemptAtMs);
          return;
        }
      }
    }
  }

  async #drainEphemerals(): Promise<void> {
    const pending = this.#ephemeralQueue.shift();
    if (!pending) return;
    try {
      await this.#deliverEphemeralWithinDeadline(pending);
    } catch (error) {
      // The live ring is the only source. Eviction is therefore visible best-effort loss, not a
      // retry cursor or a copied body in this runner.
      console.warn({
        event: "durable-delivery.ephemeral-failed",
        slug: this.#options.slug,
        offset: pending.offset,
        error: deliveryErrorMessage(error),
      });
    }
  }

  async #drainFanOut(): Promise<void> {
    let cursor = this.#cursor();
    if (cursor.halted) {
      await this.#reportHalted(cursor.halted);
      return;
    }
    const fanOut = cursor.fanOut || { admittedThrough: cursor.confirmedOffset, pending: [] };
    let admittedAtHead: boolean | undefined;
    for (const item of fanOut.pending.filter((item) => item.terminal)) {
      const stamp = this.#stamp();
      try {
        await this.#options.runtime.terminal({
          afterOffset: item.offset - 1,
          attempts: item.attempt,
          error: item.error || "delivery exhausted",
          fanOut: true,
          resumeAtOffset: item.resumeAtOffset,
        });
        const current = this.#cursor().fanOut;
        const reported = current?.pending.find(
          (candidate) =>
            candidate.offset === item.offset &&
            candidate.terminal &&
            candidate.resumeAtOffset === item.resumeAtOffset,
        );
        if (!this.#isCurrent(stamp) || !current || !reported) return;
        current.pending.splice(current.pending.indexOf(reported), 1);
        this.#putCursor({ ...this.#cursor(), fanOut: current });
      } catch {
        if (this.#isCurrent(stamp)) await this.#options.runtime.scheduleWake(Date.now() + 1_000);
        return;
      }
    }
    const room = this.#options.maxPending - fanOut.pending.length;
    if (room > 0) {
      const stamp = this.#stamp();
      let page: Awaited<ReturnType<DurableDeliveryRuntime["read"]>>;
      try {
        page = await this.#options.runtime.read(
          fanOut.admittedThrough,
          Math.min(pageLimit, room),
          stamp.resumeAtOffset,
        );
      } catch {
        if (this.#isCurrent(stamp))
          await this.#options.runtime.scheduleWake(Date.now() + busyRetryDelayMs);
        return;
      }
      {
        if (!this.#isCurrent(stamp)) return;
        cursor = this.#cursor();
        const currentFanOut = cursor.fanOut || {
          admittedThrough: cursor.confirmedOffset,
          pending: [],
        };
        if (currentFanOut.admittedThrough !== fanOut.admittedThrough)
          return await this.#drainFanOut();
        const additions = page.offsets.map((offset) => ({
          offset,
          attempt: 0,
          resumeAtOffset: stamp.resumeAtOffset,
        }));
        currentFanOut.pending.push(...additions);
        currentFanOut.admittedThrough = page.scannedThroughOffset;
        cursor = { ...cursor, fanOut: currentFanOut };
        this.#putCursor(cursor);
        admittedAtHead = page.atHead;
      }
    }
    const currentFanOut = this.#cursor().fanOut || fanOut;
    const drainStamp = this.#stamp();
    const due = currentFanOut.pending
      .filter(
        (item) =>
          !item.terminal &&
          (item.nextAttemptAtMs === undefined || item.nextAttemptAtMs <= Date.now()),
      )
      .slice(0, this.#options.concurrency);
    await Promise.all(due.map((item) => this.#deliverFanOutItem(item)));
    if (!this.#isCurrent(drainStamp)) return;
    const settled = this.#cursor().fanOut || currentFanOut;
    const next = settled.pending
      .filter((item) => !item.terminal && item.nextAttemptAtMs)
      .reduce<number | undefined>(
        (earliest, item) =>
          earliest === undefined || item.nextAttemptAtMs! < earliest
            ? item.nextAttemptAtMs
            : earliest,
        undefined,
      );
    if (settled.pending.some((item) => item.terminal)) return await this.#drainFanOut();
    if (settled.pending.some((item) => !item.terminal && !item.nextAttemptAtMs))
      return await this.#drainFanOut();
    // A backoff is per event. Keep admitting later pages while there is room so one slow webhook
    // cannot turn a catch-up into one page per retry delay.
    if (!admittedAtHead && settled.pending.length < this.#options.maxPending)
      return await this.#drainFanOut();
    if (next !== undefined) await this.#options.runtime.scheduleWake(next);
    else if (settled.pending.length === 0) {
      if (admittedAtHead) await this.#options.runtime.scheduleWake(null);
      else return await this.#drainFanOut();
    }
  }

  async #deliverFanOutItem(item: FanOutPending): Promise<void> {
    const stamp = this.#stamp();
    if (!this.#isCurrent(stamp)) return;
    let cursor = this.#cursor();
    let fanOut = cursor.fanOut;
    let current = fanOut?.pending.find((candidate) => candidate.offset === item.offset);
    if (!fanOut || !current || current.terminal) return;
    const interruptedAtLimit = current.attempt >= this.#options.maxAttempts;
    if (!interruptedAtLimit) current.attempt += 1;
    current.nextAttemptAtMs = Date.now() + this.#options.callDeadlineMs;
    current.resumeAtOffset = stamp.resumeAtOffset;
    const attempt = current.attempt;
    this.#putCursor({ ...cursor, fanOut });
    try {
      if (interruptedAtLimit)
        throw new Error(current.error ?? "delivery did not settle before its host restarted");
      await this.#deliverWithinDeadline({
        range: { after: current.offset - 1, through: current.offset },
        offsets: [current.offset],
        resumeAtOffset: stamp.resumeAtOffset,
      });
      if (!this.#isCurrent(stamp)) return;
      cursor = this.#cursor();
      fanOut = cursor.fanOut;
      current = fanOut?.pending.find(
        (candidate) =>
          candidate.offset === item.offset &&
          candidate.attempt === attempt &&
          candidate.resumeAtOffset === stamp.resumeAtOffset,
      );
      if (!fanOut || !current) return;
      fanOut.pending.splice(fanOut.pending.indexOf(current), 1);
      this.#putCursor({ ...cursor, fanOut });
      return;
    } catch (error) {
      if (!this.#isCurrent(stamp)) return;
      cursor = this.#cursor();
      fanOut = cursor.fanOut;
      current = fanOut?.pending.find(
        (candidate) =>
          candidate.offset === item.offset &&
          candidate.attempt === attempt &&
          candidate.resumeAtOffset === stamp.resumeAtOffset,
      );
      if (!fanOut || !current) return;
      if (deliveryBusy(error) || staleResume(error, stamp.resumeAtOffset)) {
        current.attempt = attempt - 1;
        current.nextAttemptAtMs = Date.now() + busyRetryDelayMs;
        current.error = undefined;
      } else {
        current.error = deliveryErrorMessage(error);
        if (configuredTargetFailure(error)) {
          await this.#haltFanOutTarget(cursor, fanOut, current, error, stamp.resumeAtOffset);
          return;
        }
        if (permanentFailure(error) || current.attempt >= this.#options.maxAttempts)
          current.terminal = true;
        else
          current.nextAttemptAtMs =
            Date.now() +
            (this.#options.retryDelayMs || ((n) => Math.min(1_000 * 2 ** (n - 1), 30 * 60_000)))(
              current.attempt,
            );
      }
      this.#putCursor({ ...cursor, fanOut });
      return;
    }
  }

  /** Stops every fan-out item for a configuration-level target refusal. Keep the pending offsets:
   * a later resume must retry the same admitted work, not rediscover only future events. */
  async #haltFanOutTarget(
    cursor: DurableDeliveryCursor,
    fanOut: NonNullable<DurableDeliveryCursor["fanOut"]>,
    current: FanOutPending,
    error: unknown,
    resumeAtOffset: number | undefined,
  ): Promise<void> {
    if (this.#disposed) return;
    const attempts = current.attempt;
    const halted = {
      after: fanOut.admittedThrough,
      attempts,
      error: current.error || deliveryErrorMessage(error),
      resumeAtOffset,
    };
    this.#generation++;
    this.#resumeAtOffset = resumeAtOffset;
    this.#putCursor({ ...cursor, fanOut, halted });
    await this.#reportHalted(halted);
  }

  /** Reports one row-level terminal receipt and leaves the row frozen if that append must retry. */
  async #reportHalted(halted: NonNullable<DurableDeliveryCursor["halted"]>): Promise<void> {
    if (halted.terminalReported || this.#disposed) return;
    const stamp = this.#stamp();
    try {
      await this.#options.runtime.terminal({
        afterOffset: halted.after,
        attempts: halted.attempts,
        error: halted.error,
        resumeAtOffset: halted.resumeAtOffset,
      });
      const current = this.#cursor().halted;
      if (
        this.#isCurrent(stamp) &&
        current?.after === halted.after &&
        current.attempts === halted.attempts &&
        current.resumeAtOffset === halted.resumeAtOffset
      )
        this.#putCursor({
          ...this.#cursor(),
          halted: { ...current, terminalReported: true },
        });
    } catch {
      if (this.#isCurrent(stamp)) await this.#options.runtime.scheduleWake(Date.now() + 1_000);
    }
  }

  #stamp(): { generation: number; resumeAtOffset: number | undefined } {
    return { generation: this.#generation, resumeAtOffset: this.#resumeAtOffset };
  }

  #isCurrent(stamp: { generation: number; resumeAtOffset: number | undefined }): boolean {
    return (
      !this.#disposed &&
      this.#generation === stamp.generation &&
      this.#resumeAtOffset === stamp.resumeAtOffset
    );
  }

  #isCurrentPending(
    pending: NonNullable<DurableDeliveryCursor["pending"]>,
    attempt: number,
  ): boolean {
    const current = this.#cursor().pending;
    return (
      current?.after === pending.after &&
      current.through === pending.through &&
      current.attempt === attempt &&
      current.resumeAtOffset === pending.resumeAtOffset
    );
  }

  async #deliverWithinDeadline(
    input: Parameters<DurableDeliveryRuntime["deliver"]>[0],
  ): Promise<void> {
    return await this.#withinDeadline(() => this.#options.runtime.deliver(input));
  }

  async #deliverEphemeralWithinDeadline(
    input: Parameters<DurableDeliveryRuntime["deliverEphemeral"]>[0],
  ): Promise<void> {
    return await this.#withinDeadline(() => this.#options.runtime.deliverEphemeral(input));
  }

  async #withinDeadline(deliver: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = deliver();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("durable delivery call timed out")),
        this.#options.callDeadlineMs,
      );
    });
    try {
      await Promise.race([result, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
