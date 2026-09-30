// stream/durable-delivery.ts — an ordinary processor that owns durable subscription progress in its
// facet KV. The context only pushes and wakes the processor; this class reads source pages, retains
// a bounded scanned range while its call is unsettled, and asks the host to invoke the configured
// expression under ordinary delivery authority.

import { z } from "zod";
import { errorCode } from "../lib.ts";
import {
  consumesEvent,
  defineProcessorContract,
  type EngineKv,
  type ProcessEventArgs,
  type ScannedRange,
  StreamProcessor,
  type StreamEvent,
} from "./processor.ts";

export type DurableDeliveryCursor = {
  confirmedOffset: number;
  pending?: {
    after: number;
    through: number;
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
  ): Promise<{
    events: StreamEvent[];
    scannedThroughOffset: number;
    atHead: boolean;
    /** Native host holds the shared body reservation until this page is disposed. */
    [Symbol.dispose]?: () => void;
  }>;
  /** Resolve and invoke the stored subscribe target afresh under Caller.delivery. */
  deliver(input: {
    target: unknown;
    events: StreamEvent[];
    range: ScannedRange;
    /** Resume control identity captured before this call began. */
    resumeAtOffset?: number;
    deliveryKey?: string;
  }): Promise<void>;
  scheduleWake(atMs: number | null): Promise<void>;
  /** Ends this facet incarnation when an invoke exceeds its persisted deadline. */
  abort(reason: string): void;
  /** Reserves aggregate facet memory for an ephemeral body held outside a page lease. */
  tryReservePendingEphemeral(chars: number): Disposable | undefined;
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
  target: unknown;
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
const ephemeralQueueBudgetChars = 8 * 1024 * 1024;

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

/** The SDK replacement for one durable `subscribe` row. It stores only a cursor plus at most one
 * pending scanned range; source bodies stay in the event log and are read again for every attempt. */
export class DurableDeliveryProcessor extends StreamProcessor<Record<string, never>> {
  readonly contract;
  readonly #options: Required<
    Pick<DurableDeliveryOptions, "maxAttempts" | "concurrency" | "maxPending" | "callDeadlineMs">
  > &
    DurableDeliveryOptions;
  #requested = false;
  #again = false;
  #resumeAtOffset: number | undefined;
  #generation = 0;
  #ephemeralQueue: {
    event: StreamEvent;
    chars: number;
    lease: Disposable;
    resumeAtOffset: number | undefined;
  }[] = [];
  #ephemeralQueueChars = 0;
  #ephemeralDrainRequested = false;

  constructor(options: DurableDeliveryOptions) {
    super();
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
    this.contract = defineProcessorContract({
      slug: options.slug,
      version: "1",
      description: "durable subscription processor",
      stateSchema: z.object({}),
      consumes: options.consumes ? [...options.consumes] : ["*"],
      emits: [],
    });
  }

  override processEvent(args: ProcessEventArgs<Record<string, never>>): undefined {
    // Ephemerals are intentionally best effort: the push carries their only body, and no KV write
    // turns them into durable work. A restart before this call begins loses them as it does today.
    if (
      !this.#options.fanOut &&
      args.event?.ephemeral &&
      consumesEvent(this.#options.consumes, args.event)
    )
      this.#queueEphemeral(args.event, args.runInBackground);
    this.#requestDrain(args.runInBackground);
  }

  #queueEphemeral(
    event: StreamEvent,
    runInBackground: (work: () => Promise<unknown>) => void,
  ): void {
    const chars = JSON.stringify(event).length;
    // Ephemerals are best effort, but queued bodies must share one facet-wide budget. Drop oldest
    // local bodies first so a busy row keeps the newest push and returns its reservation promptly.
    while (
      this.#ephemeralQueue.length > 0 &&
      this.#ephemeralQueueChars + chars > ephemeralQueueBudgetChars
    )
      this.#discardOldestEphemeral();
    let lease = this.#options.runtime.tryReservePendingEphemeral(chars);
    while (!lease && this.#ephemeralQueue.length > 0) {
      this.#discardOldestEphemeral();
      lease = this.#options.runtime.tryReservePendingEphemeral(chars);
    }
    if (!lease) {
      console.warn({
        event: "durable-delivery.ephemeral-dropped",
        slug: this.#options.slug,
        dropped: 1,
        queuedChars: this.#ephemeralQueueChars,
      });
      return;
    }
    this.#ephemeralQueue.push({ event, chars, lease, resumeAtOffset: this.#resumeAtOffset });
    this.#ephemeralQueueChars += chars;
    if (this.#ephemeralDrainRequested) return;
    this.#ephemeralDrainRequested = true;
    runInBackground(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      try {
        while (this.#ephemeralQueue.length > 0) {
          const pending = this.#ephemeralQueue.shift()!;
          this.#ephemeralQueueChars -= pending.chars;
          try {
            await this.#deliverWithinDeadline({
              target: this.#options.target,
              events: [pending.event],
              range: { after: pending.event.offset - 1, through: pending.event.offset },
              resumeAtOffset: pending.resumeAtOffset,
            });
          } finally {
            pending.lease[Symbol.dispose]();
          }
        }
      } finally {
        this.#ephemeralDrainRequested = false;
      }
    });
  }

  #discardOldestEphemeral(): void {
    const pending = this.#ephemeralQueue.shift();
    if (!pending) return;
    this.#ephemeralQueueChars -= pending.chars;
    pending.lease[Symbol.dispose]();
  }

  /** Releases bodies held only by this runner when its configured row is replaced. */
  [Symbol.dispose](): void {
    while (this.#ephemeralQueue.length > 0) this.#discardOldestEphemeral();
  }

  /** The subscriptions facet calls this after configuration and revive. It shares the normal
   * processor background/claim path without exposing a second delivery API to authors. */
  drive(runInBackground: (work: () => Promise<unknown>) => void): void {
    this.#requestDrain(runInBackground);
  }

  /** The subscriptions facet applies the existing resume control fact before calling drive. */
  resume(afterOffset?: number, offset?: number, resumeAtOffset?: number): boolean {
    this.#resumeAtOffset = resumeAtOffset;
    this.#generation++;
    const cursor = this.#cursor();
    if (cursor.fanOut) {
      const pending = cursor.fanOut.pending.map((item) =>
        item.terminal && (offset === undefined || item.offset === offset)
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
      this.#putCursor({ ...cursor, fanOut: { ...cursor.fanOut, pending } });
      return true;
    }
    if (!cursor.halted) return false;
    this.#putCursor({ confirmedOffset: afterOffset ?? cursor.confirmedOffset });
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
        if (this.#again) {
          this.#again = false;
          void this.#requestDrain(runInBackground);
        }
      }
    });
  }

  async #drain(): Promise<void> {
    if (this.#options.fanOut) return await this.#drainFanOut();
    for (;;) {
      let cursor = this.#cursor();
      if (cursor.halted) {
        if (cursor.halted.terminalReported) return;
        const stamp = this.#stamp();
        const halted = cursor.halted;
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
        return;
      }
      if (cursor.pending?.nextAttemptAtMs && cursor.pending.nextAttemptAtMs > Date.now()) {
        await this.#options.runtime.scheduleWake(cursor.pending.nextAttemptAtMs);
        return;
      }
      if (!cursor.pending) {
        const stamp = this.#stamp();
        const page = await this.#options.runtime.read(cursor.confirmedOffset, pageLimit);
        try {
          if (!this.#isCurrent(stamp)) return;
          cursor = this.#cursor();
          if (cursor.pending || cursor.halted) continue;
          if (page.scannedThroughOffset <= cursor.confirmedOffset) {
            await this.#options.runtime.scheduleWake(null);
            return;
          }
          const events = page.events.filter(
            (event) => !event.ephemeral && consumesEvent(this.#options.consumes, event),
          );
          if (events.length === 0) {
            this.#putCursor({ confirmedOffset: page.scannedThroughOffset });
            continue;
          }
          cursor = {
            ...cursor,
            pending: {
              after: cursor.confirmedOffset,
              through: page.scannedThroughOffset,
              attempt: 0,
              resumeAtOffset: stamp.resumeAtOffset,
            },
          };
          this.#putCursor(cursor);
        } finally {
          page[Symbol.dispose]?.();
        }
      }
      const pending = cursor.pending!;
      const stamp = this.#stamp();
      const page = await this.#options.runtime.read(pending.after, pageLimit);
      try {
        if (!this.#isCurrent(stamp) || !this.#isCurrentPending(pending, pending.attempt)) return;
        const events = page.events
          .filter((event) => event.offset <= pending.through)
          .filter((event) => !event.ephemeral && consumesEvent(this.#options.consumes, event));
        // Only selected bodies cross the target call; release skipped page bodies before it awaits.
        page.events.length = 0;
        const attempt = pending.attempt + 1;
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
          await this.#deliverWithinDeadline({
            target: this.#options.target,
            events,
            range: { after: pending.after, through: pending.through },
            resumeAtOffset: stamp.resumeAtOffset,
            deliveryKey: `${this.#options.slug}:${pending.after}-${pending.through}`,
          });
          if (!this.#isCurrent(stamp) || !this.#isCurrentPending(pending, attempt)) return;
          this.#putCursor({ confirmedOffset: pending.through });
        } catch (error) {
          if (!this.#isCurrent(stamp) || !this.#isCurrentPending(pending, attempt)) return;
          const message = error instanceof Error ? error.message : String(error);
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
      } finally {
        page[Symbol.dispose]?.();
      }
    }
  }

  async #drainFanOut(): Promise<void> {
    let cursor = this.#cursor();
    const fanOut = cursor.fanOut || { admittedThrough: cursor.confirmedOffset, pending: [] };
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
      const page = await this.#options.runtime.read(
        fanOut.admittedThrough,
        Math.min(pageLimit, room),
      );
      try {
        if (!this.#isCurrent(stamp)) return;
        cursor = this.#cursor();
        const currentFanOut = cursor.fanOut || {
          admittedThrough: cursor.confirmedOffset,
          pending: [],
        };
        if (currentFanOut.admittedThrough !== fanOut.admittedThrough)
          return await this.#drainFanOut();
        const additions = page.events
          .filter((event) => !event.ephemeral && consumesEvent(this.#options.consumes, event))
          .map((event) => ({
            offset: event.offset,
            attempt: 0,
            resumeAtOffset: stamp.resumeAtOffset,
          }));
        currentFanOut.pending.push(...additions);
        currentFanOut.admittedThrough = page.scannedThroughOffset;
        cursor = { ...cursor, fanOut: currentFanOut };
        this.#putCursor(cursor);
      } finally {
        page[Symbol.dispose]?.();
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
    if (next !== undefined) await this.#options.runtime.scheduleWake(next);
    else if (settled.pending.length === 0) await this.#options.runtime.scheduleWake(null);
  }

  async #deliverFanOutItem(item: FanOutPending): Promise<void> {
    const stamp = this.#stamp();
    const page = await this.#options.runtime.read(item.offset - 1, 1);
    try {
      if (!this.#isCurrent(stamp)) return;
      let cursor = this.#cursor();
      let fanOut = cursor.fanOut;
      let current = fanOut?.pending.find((candidate) => candidate.offset === item.offset);
      if (!fanOut || !current || current.terminal) return;
      const event = page.events.find((candidate) => candidate.offset === current!.offset);
      if (!event) {
        current.attempt = this.#options.maxAttempts;
        current.error = "delivery source event is no longer readable";
        current.terminal = true;
        this.#putCursor({ ...cursor, fanOut });
        return;
      }
      current.attempt += 1;
      current.nextAttemptAtMs = Date.now() + this.#options.callDeadlineMs;
      current.resumeAtOffset = stamp.resumeAtOffset;
      const attempt = current.attempt;
      this.#putCursor({ ...cursor, fanOut });
      try {
        await this.#deliverWithinDeadline({
          target: this.#options.target,
          events: [event],
          range: { after: current.offset - 1, through: current.offset },
          resumeAtOffset: stamp.resumeAtOffset,
          deliveryKey: `${this.#options.slug}:${event.path}@${event.offset}`,
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
        current.error = error instanceof Error ? error.message : String(error);
        if (permanentFailure(error) || current.attempt >= this.#options.maxAttempts)
          current.terminal = true;
        else
          current.nextAttemptAtMs =
            Date.now() +
            (this.#options.retryDelayMs || ((n) => Math.min(1_000 * 2 ** (n - 1), 30 * 60_000)))(
              current.attempt,
            );
      }
      if (this.#isCurrent(stamp) && fanOut && current)
        this.#putCursor({ ...this.#cursor(), fanOut });
    } finally {
      page[Symbol.dispose]?.();
    }
  }

  #stamp(): { generation: number; resumeAtOffset: number | undefined } {
    return { generation: this.#generation, resumeAtOffset: this.#resumeAtOffset };
  }

  #isCurrent(stamp: { generation: number; resumeAtOffset: number | undefined }): boolean {
    // `undefined` is the pre-resume generation; it must not compare equal to a later numeric fence.
    // oxlint-disable-next-line iterate/simple-truthiness-check
    return this.#generation === stamp.generation && this.#resumeAtOffset === stamp.resumeAtOffset;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deliver = this.#options.runtime.deliver(input);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          this.#options.runtime.abort(
            `durable delivery call exceeded ${this.#options.callDeadlineMs}ms`,
          );
        } catch (error) {
          reject(error);
          return;
        }
        reject(new Error("durable delivery call timed out"));
      }, this.#options.callDeadlineMs);
    });
    try {
      await Promise.race([deliver, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
