// subscription-delivery-durable-object.ts — the platform's one private `subscriptions` facet.
// Durable subscription rows remain configuration in the context's core state; this facet owns only
// the bounded SDK cursors. It receives current row identities with each push and asks the context's
// private bridge to re-read and invoke a row on every attempt.

import { reportIssue } from "iterate/lib";
import { FacetDurableObject } from "iterate/sdk";
import {
  DurableDeliveryProcessor,
  type DurableDeliveryRuntime,
} from "iterate/stream/durable-delivery";
import type { ProcessEventArgs, ScannedRange, StreamEvent } from "iterate/stream/processor";

export type DurableSubscriptionConfig = {
  name: string;
  configuredAtOffset: number;
  consumes?: string[];
  afterOffset?: number;
  ordered?: false;
  resumedAtOffset?: number;
  resumedAfterOffset?: number;
  resumedOffset?: number;
  /** Retained rows keep their terminal cursor observable, but never receive new deliveries. */
  halted?: true;
  maxAttempts?: number;
  retryCapMs?: number;
};

type ContextDeliveryBridge = {
  readSubscriptionDelivery(
    afterOffset: number,
    limit: number,
  ): Promise<{
    events: StreamEvent[];
    scannedThroughOffset: number;
    atHead: boolean;
  }>;
  deliverConfiguredSubscription(input: {
    name: string;
    configuredAtOffset: number;
    resumeAtOffset?: number;
    range: ScannedRange;
    events: StreamEvent[];
  }): Promise<void>;
  recordConfiguredSubscriptionTerminal(input: {
    name: string;
    configuredAtOffset: number;
    afterOffset: number;
    attempts: number;
    error: string;
    fanOut?: true;
    resumeAtOffset?: number;
  }): Promise<void>;
  claimSubscriptionDelivery(at: number | null): Promise<void>;
};

/** A first-party facet, reached by the context only through FacetHost's platform call. */
export class SubscriptionDeliveryDurableObject extends FacetDurableObject<{
  ITERATE_CONTEXT: DurableObjectNamespace;
  ITX?: never;
}> {
  static override publicMethods = [...super.publicMethods];

  readonly #runners = new Map<string, DurableDeliveryProcessor>();
  static readonly #configKey = "durable-subscription-config";
  static readonly #pageReservationChars = 8 * 1024 * 1024;
  static readonly #pendingEphemeralBudgetChars = 8 * 1024 * 1024;
  #pendingEphemeralChars = 0;
  readonly #wakeByRunner = new Map<string, number>();
  #configurationFingerprint: string | undefined;
  /** One 8MiB source page at a time across all runners, before any page body is materialized. */
  #readReserved = false;
  readonly #readWaiters: Array<() => void> = [];
  #background = 0;

  /** One context commit and its current durable-row identities. The rows are configuration only:
   * target expressions and event bodies never enter this facet or its storage. */
  async processEventBatch(
    events: StreamEvent[],
    _range: ScannedRange,
    rows: DurableSubscriptionConfig[],
  ): Promise<void> {
    // A commit is an immediate wake. Its drains either establish a new earliest retry or release
    // the prior one when every cursor is caught up.
    this.#wakeByRunner.clear();
    this.#reconcile(rows);
    for (const row of rows) {
      if (row.halted) continue;
      const runner = this.#runners.get(`${row.name}@${row.configuredAtOffset}`)!;
      for (const event of events) runner.processEvent(this.#args(event));
      runner.processEvent(this.#args(null));
    }
  }

  /** The context alarm revives a pending cursor after a facet or context incarnation dies. */
  async revive(): Promise<void> {
    this.#wakeByRunner.clear(); // the alarm spent the prior claim; a runner reclaims only if it still needs one
    this.#reconcile(
      this.ctx.storage.kv.get<DurableSubscriptionConfig[]>(
        SubscriptionDeliveryDurableObject.#configKey,
      ) || [],
    );
    for (const row of this.ctx.storage.kv.get<DurableSubscriptionConfig[]>(
      SubscriptionDeliveryDurableObject.#configKey,
    ) || []) {
      if (!row.halted)
        this.#runners.get(`${row.name}@${row.configuredAtOffset}`)?.processEvent(this.#args(null));
    }
  }

  /** Platform-only operational view: cursor offsets and bounded retry state, never event bodies. */
  deliverySnapshots(): Record<string, ReturnType<DurableDeliveryProcessor["snapshot"]>> {
    if (this.#runners.size === 0)
      this.#reconcile(
        this.ctx.storage.kv.get<DurableSubscriptionConfig[]>(
          SubscriptionDeliveryDurableObject.#configKey,
        ) || [],
      );
    return Object.fromEntries([...this.#runners].map(([key, runner]) => [key, runner.snapshot()]));
  }

  /** Platform operational state for the context's bounded durable-delivery resources. It is reached
   * only through IterateContextDurableObject's native diagnostic, never an itx/client capability. */
  deliveryResourceSnapshot(): {
    readReservedBytes: number;
    readWaiters: number;
    pendingEphemeralChars: number;
  } {
    return {
      readReservedBytes: this.#readReserved
        ? SubscriptionDeliveryDurableObject.#pageReservationChars
        : 0,
      readWaiters: this.#readWaiters.length,
      pendingEphemeralChars: this.#pendingEphemeralChars,
    };
  }

  #reconcile(rows: DurableSubscriptionConfig[]): void {
    // Facet JS state is discarded on hibernation; keep only immutable row identity/configuration,
    // never a target, event, callback, or native RPC value.
    const fingerprint = JSON.stringify(rows);
    if (fingerprint !== this.#configurationFingerprint) {
      this.ctx.storage.kv.put(SubscriptionDeliveryDurableObject.#configKey, rows);
      this.#configurationFingerprint = fingerprint;
    }
    const live = new Set(rows.map((row) => `${row.name}@${row.configuredAtOffset}`));
    for (const [key] of this.#runners)
      if (!live.has(key)) {
        // A replacement has a distinct configured offset. Its predecessor's persisted cursor must
        // never be resumed under the new target, and its claim is released with it.
        this.#runners.get(key)?.[Symbol.dispose]();
        this.#runners.delete(key);
        this.#wakeByRunner.delete(key);
        this.ctx.storage.kv.delete(`durable-delivery/${key}`);
        this.ctx.storage.kv.delete(`durable-delivery-resumed/${key}`);
      }
    for (const row of rows) {
      const key = `${row.name}@${row.configuredAtOffset}`;
      let runner = this.#runners.get(key);
      if (!runner) {
        runner = new DurableDeliveryProcessor({
          slug: key,
          target: null,
          consumes: row.consumes,
          afterOffset: row.afterOffset ?? row.configuredAtOffset,
          resumeAtOffset: row.resumedAtOffset,
          maxAttempts: row.maxAttempts,
          retryDelayMs: row.retryCapMs
            ? (attempt: number) =>
                Math.min(1_000 * 2 ** (attempt - 1), row.retryCapMs ?? 30 * 60_000)
            : undefined,
          ...(row.ordered === false && { fanOut: true }),
          runtime: this.#runtimeFor(row),
        });
        this.#runners.set(key, runner);
      }
      if (
        row.resumedAtOffset !== undefined &&
        this.ctx.storage.kv.get<number>(`durable-delivery-resumed/${key}`) !== row.resumedAtOffset
      ) {
        runner.resume(row.resumedAfterOffset, row.resumedOffset, row.resumedAtOffset);
        this.ctx.storage.kv.put(`durable-delivery-resumed/${key}`, row.resumedAtOffset);
      }
    }
  }

  #runtimeFor(row: DurableSubscriptionConfig): DurableDeliveryRuntime {
    return {
      storage: this.ctx.storage.kv,
      // Infrastructure uses the kernel-owned context stub. It never resolves through itx,
      // so a project rewrite, provide, or jail cannot alter cursor proof or claims.
      read: (afterOffset, limit) => this.#readSourcePage(afterOffset, limit),
      deliver: ({ events, range, resumeAtOffset }) =>
        this.#context().deliverConfiguredSubscription({
          name: row.name,
          configuredAtOffset: row.configuredAtOffset,
          resumeAtOffset,
          range,
          events,
        }),
      scheduleWake: async (atMs) => {
        const key = `${row.name}@${row.configuredAtOffset}`;
        if (atMs === null) this.#wakeByRunner.delete(key);
        else this.#wakeByRunner.set(key, atMs);
        await this.#syncClaim();
      },
      // The context-side single-flight guard owns an unanswered target call across a facet
      // restart. Resetting this shared facet would discard unrelated rows, so the deadline simply
      // lets the runner persist bounded retry state while the guard rejects overlap.
      abort: () => undefined,
      tryReservePendingEphemeral: (chars) => this.#reservePendingEphemeral(chars),
      terminal: async ({ afterOffset, attempts, error, fanOut, resumeAtOffset }) => {
        await this.#context().recordConfiguredSubscriptionTerminal({
          name: row.name,
          configuredAtOffset: row.configuredAtOffset,
          afterOffset,
          attempts,
          error: error.slice(0, 1024),
          fanOut,
          resumeAtOffset,
        });
      },
    };
  }

  #context(): ContextDeliveryBridge {
    return this.env.ITERATE_CONTEXT.getByName(
      this.ctx.props.iterateContextName,
    ) as unknown as ContextDeliveryBridge;
  }

  async #readSourcePage(
    afterOffset: number,
    limit: number,
  ): Promise<{
    events: StreamEvent[];
    scannedThroughOffset: number;
    atHead: boolean;
    [Symbol.dispose](): void;
  }> {
    await this.#reserveRead();
    try {
      const page = await this.#context().readSubscriptionDelivery(afterOffset, limit);
      let released = false;
      return {
        ...page,
        [Symbol.dispose]: () => {
          if (released) return;
          released = true;
          this.#releaseRead();
        },
      };
    } catch (error) {
      this.#releaseRead();
      throw error;
    }
  }

  #reserveRead(): Promise<void> {
    if (!this.#readReserved) {
      this.#readReserved = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#readWaiters.push(resolve));
  }

  #releaseRead(): void {
    const waiter = this.#readWaiters.shift();
    if (waiter) return waiter();
    this.#readReserved = false;
  }

  #reservePendingEphemeral(chars: number): Disposable | undefined {
    if (chars > SubscriptionDeliveryDurableObject.#pendingEphemeralBudgetChars) return undefined;
    if (
      this.#pendingEphemeralChars + chars >
      SubscriptionDeliveryDurableObject.#pendingEphemeralBudgetChars
    )
      return undefined;
    this.#pendingEphemeralChars += chars;
    let released = false;
    return {
      [Symbol.dispose]: () => {
        if (released) return;
        released = true;
        this.#pendingEphemeralChars -= chars;
      },
    };
  }

  #args(event: StreamEvent | null): ProcessEventArgs<Record<string, never>> {
    return {
      event,
      state: {},
      previousState: {},
      append: async () => [],
      blockProcessorWhile: (work) => this.#runInBackground(work),
      runInBackground: (work) => this.#runInBackground(work),
      delivery: { caughtUp: true },
    };
  }

  #runInBackground(work: () => Promise<unknown>): void {
    this.#background++;
    this.ctx.waitUntil(
      this.#syncClaim()
        .then(work)
        .catch((error) =>
          reportIssue("subscription-delivery.facet-background", error, {
            context: this.ctx.props.iterateContextName,
          }),
        )
        .finally(async () => {
          this.#background--;
          await this.#syncClaim();
        }),
    );
  }

  async #syncClaim(): Promise<void> {
    const wakeAt = [...this.#wakeByRunner.values()].reduce<number | null>(
      (earliest, at) => (earliest === null || at < earliest ? at : earliest),
      null,
    );
    const at = this.#background > 0 ? Date.now() + 20_000 : wakeAt;
    await this.#context().claimSubscriptionDelivery(at);
  }
}
