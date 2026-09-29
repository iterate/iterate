// stream/durable-delivery.ts — an ordinary processor that owns durable subscription progress in its
// facet KV. The context only pushes and wakes the processor; this class reads source pages, retains
// a bounded scanned range while its call is unsettled, and asks the host to invoke the configured
// expression under ordinary delivery authority.

import { z } from "zod";
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
  };
  halted?: { after: number; attempts: number; error: string; terminalReported?: true };
  fanOut?: { admittedThrough: number; pending: FanOutPending[] };
};

type FanOutPending = {
  offset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  error?: string;
  terminal?: true;
  terminalReported?: true;
};

export type DurableDeliveryRuntime = {
  storage: EngineKv;
  read(
    afterOffset: number,
    limit: number,
  ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number; atHead: boolean }>;
  /** Resolve and invoke the stored subscribe target afresh under Caller.delivery. */
  deliver(input: {
    target: unknown;
    events: StreamEvent[];
    range: ScannedRange;
    deliveryKey?: string;
  }): Promise<void>;
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
  target: unknown;
  consumes: readonly string[];
  wakeEventType: string;
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
};

const pageLimit = 100;

/** The SDK replacement for one durable `subscribe` row. It stores only a cursor plus at most one
 * pending scanned range; source bodies stay in the event log and are read again for every attempt. */
export class DurableDeliveryProcessor extends StreamProcessor<Record<string, never>> {
  readonly contract;
  readonly #options: Required<
    Pick<DurableDeliveryOptions, "maxAttempts" | "concurrency" | "maxPending">
  > &
    DurableDeliveryOptions;
  #requested = false;
  #again = false;
  #resumeAtOffset: number | undefined;

  constructor(options: DurableDeliveryOptions) {
    super();
    if (!options.slug || !options.wakeEventType)
      throw new Error("durable delivery needs slug and wake event type");
    const maxAttempts = options.maxAttempts ?? 15;
    const concurrency = options.concurrency ?? 8;
    const maxPending = options.maxPending ?? 1_000;
    if (
      ![maxAttempts, concurrency, maxPending].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error("durable delivery limits must be positive finite integers");
    this.#options = { ...options, maxAttempts, concurrency, maxPending };
    this.#resumeAtOffset = options.resumeAtOffset;
    this.contract = defineProcessorContract({
      slug: options.slug,
      version: "1",
      description: "durable subscription processor",
      stateSchema: z.object({}),
      consumes: [...options.consumes, options.wakeEventType],
      emits: [],
    });
  }

  override processEvent(args: ProcessEventArgs<Record<string, never>>): undefined {
    // Ephemerals are intentionally best effort: the push carries their only body, and no KV write
    // turns them into durable work. A restart before this call begins loses them as it does today.
    if (
      args.event?.ephemeral &&
      args.event.type !== this.#options.wakeEventType &&
      consumesEvent(this.#options.consumes, args.event)
    )
      args.runInBackground(
        async () =>
          await this.#options.runtime.deliver({
            target: this.#options.target,
            events: [args.event!],
            range: { after: args.event!.offset - 1, through: args.event!.offset },
          }),
      );
    this.#requestDrain(args.runInBackground);
  }

  /** The subscriptions facet calls this after configuration and revive. It shares the normal
   * processor background/claim path without exposing a second delivery API to authors. */
  drive(runInBackground: (work: () => Promise<unknown>) => void): void {
    this.#requestDrain(runInBackground);
  }

  /** The subscriptions facet applies the existing resume control fact before calling drive. */
  resume(afterOffset?: number, offset?: number, resumeAtOffset?: number): boolean {
    this.#resumeAtOffset = resumeAtOffset;
    const cursor = this.#cursor();
    if (cursor.fanOut) {
      const pending = cursor.fanOut.pending.map((item) =>
        item.terminal && (offset === undefined || item.offset === offset)
          ? {
              ...item,
              terminal: undefined,
              terminalReported: undefined,
              attempt: 0,
              nextAttemptAtMs: undefined,
            }
          : item,
      );
      // A terminal receipt is removed after the host acknowledges its dead-letter fact, so a
      // selective operator resume recreates that one item even after a cold revive. Its offset is
      // below admittedThrough and therefore cannot be rediscovered by normal admission.
      if (offset !== undefined && !pending.some((item) => item.offset === offset))
        pending.push({ offset, attempt: 0 });
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
          this.#requestDrain(runInBackground);
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
        try {
          await this.#options.runtime.terminal({
            afterOffset: cursor.halted.after,
            attempts: cursor.halted.attempts,
            error: cursor.halted.error,
            ...(this.#resumeAtOffset !== undefined && { resumeAtOffset: this.#resumeAtOffset }),
          });
          this.#putCursor({ ...cursor, halted: { ...cursor.halted, terminalReported: true } });
        } catch {
          await this.#options.runtime.scheduleWake(Date.now() + 1_000);
        }
        return;
      }
      if (cursor.pending?.nextAttemptAtMs && cursor.pending.nextAttemptAtMs > Date.now()) {
        await this.#options.runtime.scheduleWake(cursor.pending.nextAttemptAtMs);
        return;
      }
      if (!cursor.pending) {
        const page = await this.#options.runtime.read(cursor.confirmedOffset, pageLimit);
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
          },
        };
        this.#putCursor(cursor);
      }
      const pending = cursor.pending!;
      const page = await this.#options.runtime.read(pending.after, pageLimit);
      const events = page.events
        .filter((event) => event.offset <= pending.through)
        .filter((event) => !event.ephemeral && consumesEvent(this.#options.consumes, event));
      const attempt = pending.attempt + 1;
      this.#putCursor({
        ...cursor,
        pending: { ...pending, attempt, nextAttemptAtMs: Date.now() + 20_000 },
      });
      try {
        await Promise.race([
          this.#options.runtime.deliver({
            target: this.#options.target,
            events,
            range: { after: pending.after, through: pending.through },
            deliveryKey: `${this.#options.slug}:${pending.after}-${pending.through}`,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("durable delivery call timed out")), 20_000),
          ),
        ]);
        this.#putCursor({ confirmedOffset: pending.through });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= this.#options.maxAttempts) {
          this.#putCursor({
            confirmedOffset: pending.after,
            halted: { after: pending.after, attempts: attempt, error: message },
          });
          await this.#options.runtime.terminal({
            afterOffset: pending.after,
            attempts: attempt,
            error: message,
            ...(this.#resumeAtOffset !== undefined && { resumeAtOffset: this.#resumeAtOffset }),
          });
          return;
        }
        const nextAttemptAtMs =
          Date.now() +
          (this.#options.retryDelayMs || ((n) => Math.min(1_000 * 2 ** (n - 1), 30 * 60_000)))(
            attempt,
          );
        this.#putCursor({
          ...cursor,
          pending: { ...pending, attempt, nextAttemptAtMs, error: message },
        });
        await this.#options.runtime.scheduleWake(nextAttemptAtMs);
        return;
      }
    }
  }

  async #drainFanOut(): Promise<void> {
    let cursor = this.#cursor();
    const fanOut = cursor.fanOut || { admittedThrough: cursor.confirmedOffset, pending: [] };
    // Report terminal items until the host acknowledges their observable dead letter. They never
    // invoke the target again, and resume makes them pending explicitly.
    for (const item of fanOut.pending.filter((item) => item.terminal && !item.terminalReported)) {
      try {
        await this.#options.runtime.terminal({
          afterOffset: item.offset - 1,
          attempts: item.attempt,
          error: item.error || "delivery exhausted",
          fanOut: true,
          ...(this.#resumeAtOffset !== undefined && { resumeAtOffset: this.#resumeAtOffset }),
        });
        fanOut.pending.splice(fanOut.pending.indexOf(item), 1);
        this.#putCursor({ ...cursor, fanOut });
      } catch {
        await this.#options.runtime.scheduleWake(Date.now() + 1_000);
        return;
      }
    }
    const room = this.#options.maxPending - fanOut.pending.length;
    if (room > 0) {
      const page = await this.#options.runtime.read(
        fanOut.admittedThrough,
        Math.min(pageLimit, room),
      );
      const additions = page.events
        .filter((event) => !event.ephemeral && consumesEvent(this.#options.consumes, event))
        .map((event) => ({ offset: event.offset, attempt: 0 }));
      // Persist records and their scanned admission proof together before advancing. A death here
      // either repeats an event or reuses its record; it never forgets an admitted event.
      fanOut.pending.push(...additions);
      fanOut.admittedThrough = page.scannedThroughOffset;
      cursor = { ...cursor, fanOut };
      this.#putCursor(cursor);
    }
    const due = fanOut.pending
      .filter(
        (item) => !item.terminal && (!item.nextAttemptAtMs || item.nextAttemptAtMs <= Date.now()),
      )
      .slice(0, this.#options.concurrency);
    await Promise.all(due.map((item) => this.#deliverFanOutItem(cursor, fanOut, item)));
    const next = fanOut.pending
      .filter((item) => !item.terminal && item.nextAttemptAtMs)
      .reduce<number | undefined>(
        (earliest, item) =>
          earliest === undefined || item.nextAttemptAtMs! < earliest
            ? item.nextAttemptAtMs
            : earliest,
        undefined,
      );
    if (fanOut.pending.some((item) => item.terminal && !item.terminalReported))
      return await this.#drainFanOut();
    if (fanOut.pending.some((item) => !item.terminal && !item.nextAttemptAtMs))
      return await this.#drainFanOut();
    if (next !== undefined) await this.#options.runtime.scheduleWake(next);
    else if (fanOut.pending.length === 0) await this.#options.runtime.scheduleWake(null);
  }

  async #deliverFanOutItem(
    cursor: DurableDeliveryCursor,
    fanOut: NonNullable<DurableDeliveryCursor["fanOut"]>,
    item: FanOutPending,
  ): Promise<void> {
    const page = await this.#options.runtime.read(item.offset - 1, 1);
    const event = page.events.find((candidate) => candidate.offset === item.offset);
    if (!event) {
      item.attempt = this.#options.maxAttempts;
      item.error = "delivery source event is no longer readable";
      item.terminal = true;
      this.#putCursor({ ...cursor, fanOut });
      return;
    }
    item.attempt += 1;
    this.#putCursor({ ...cursor, fanOut });
    try {
      await this.#options.runtime.deliver({
        target: this.#options.target,
        events: [event],
        range: { after: item.offset - 1, through: item.offset },
        deliveryKey: `${this.#options.slug}:${event.path}@${event.offset}`,
      });
      fanOut.pending.splice(fanOut.pending.indexOf(item), 1);
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
      if (item.attempt >= this.#options.maxAttempts) item.terminal = true;
      else
        item.nextAttemptAtMs =
          Date.now() +
          (this.#options.retryDelayMs || ((n) => Math.min(1_000 * 2 ** (n - 1), 30 * 60_000)))(
            item.attempt,
          );
    }
    this.#putCursor({ ...cursor, fanOut });
  }
}
