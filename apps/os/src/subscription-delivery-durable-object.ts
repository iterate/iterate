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
import { BackgroundClaims, type ScannedRange, type StreamEvent } from "iterate/stream/processor";

export type DurableSubscriptionConfig = {
  name: string;
  configuredAtOffset: number;
  consumes?: string[];
  afterOffset?: number;
  ordered?: false;
  resumedAtOffset?: number;
  resumedAfterOffset?: number;
  resumedOffset?: number;
  /** Retained rows keep the core terminal receipt observable and invalidate stale runner work. */
  halted?: { afterOffset: number; attempts: number; error?: string };
  maxAttempts?: number;
  retryCapMs?: number;
};

type ContextDeliveryBridge = {
  /** Current core row identities after a push was lost between its durable claim and this facet. */
  subscriptionDeliveryConfiguration(): Promise<{
    rows: DurableSubscriptionConfig[];
    throughOffset: number;
  }>;
  readSubscriptionDelivery(input: {
    name: string;
    configuredAtOffset: number;
    resumeAtOffset?: number;
    afterOffset: number;
    limit: number;
  }): Promise<{
    offsets: number[];
    scannedThroughOffset: number;
    atHead: boolean;
  }>;
  deliverConfiguredSubscription(input: {
    name: string;
    configuredAtOffset: number;
    resumeAtOffset?: number;
    range: ScannedRange;
    offsets: number[];
  }): Promise<void>;
  deliverConfiguredEphemeralSubscription(input: {
    name: string;
    configuredAtOffset: number;
    resumeAtOffset?: number;
    event: StreamEvent;
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
  claimSubscriptionDelivery(input: { at: number | null; throughOffset: number }): Promise<void>;
};

/** A first-party facet, reached by the context only through FacetHost's platform call. */
export class SubscriptionDeliveryDurableObject extends FacetDurableObject<{
  ITERATE_CONTEXT: DurableObjectNamespace;
  ITX?: never;
}> {
  static override publicMethods = [...super.publicMethods];

  readonly #runners = new Map<string, DurableDeliveryProcessor>();
  #configurationThroughOffset: number | undefined;
  #needsCursorSweep = true;
  static readonly #pendingEphemeralBudgetChars = 8 * 1024 * 1024;
  #pendingEphemeralChars = 0;
  readonly #wakeByRunner = new Map<string, number>();
  readonly #backgroundClaims = new BackgroundClaims<number>({
    claim: async (at, throughOffset) => {
      if (throughOffset === undefined)
        throw new Error("subscription delivery claimed before configuration was accepted");
      await this.#context().claimSubscriptionDelivery({ at, throughOffset });
    },
    capture: () => this.#claimThroughOffset(),
    report: (error) =>
      reportIssue("subscription-delivery.facet-claim", error, {
        context: this.ctx.props.iterateContextName,
      }),
    afterMs: 20_000,
    maxAfterMs: 20_000,
  });

  constructor(
    ctx: DurableObjectState,
    env: {
      ITERATE_CONTEXT: DurableObjectNamespace;
      ITX?: never;
    },
  ) {
    super(ctx, env);
    this.ctx.storage.kv.delete("durable-delivery/configuration-through-offset");
  }

  /** One context commit and its current durable-row identities. The rows are configuration only:
   * target expressions and event bodies never enter this facet or its storage. */
  async processEventBatch(
    events: StreamEvent[],
    _range: ScannedRange,
    rows: DurableSubscriptionConfig[],
    configurationThroughOffset: number,
  ): Promise<void> {
    const cold = this.#acceptedConfigurationThroughOffset() === undefined;
    if (cold) {
      // A deleted facet has no local high-water. Pull current core configuration before reconciling
      // a delayed platform call, so an older push cannot recreate removed configuration.
      const current = await this.#context().subscriptionDeliveryConfiguration();
      rows = current.rows;
      configurationThroughOffset = current.throughOffset;
    }
    // A commit is an immediate wake. Its drains either establish a new earliest retry or release
    // the prior one when every cursor is caught up.
    if (!this.#reconcile(rows, configurationThroughOffset)) return;
    this.#wakeByRunner.clear();
    this.#restorePersistedWakes(rows);
    for (const row of rows) {
      if (row.halted) continue;
      const runner = this.#runners.get(`${row.name}@${row.configuredAtOffset}`)!;
      for (const event of events) runner.push(event);
      runner.drive((work) => this.#runInBackground(work));
    }
    // A stale first push can be the only route back to a persisted retry after this facet died.
    // Its claim must reach the context before the platform call returns.
    if (cold) {
      this.#syncClaim();
      await this.#backgroundClaims.flush();
    }
  }

  /** The context alarm revives a pending cursor after a facet or context incarnation dies. */
  async revive(): Promise<void> {
    await this.#backgroundClaims.revivedWhileBusy();
    // A context claims this first-party facet before its asynchronous post-commit push. If that
    // push died with the context, the claim revives us with no local configuration yet; core is
    // the durable source of row identity, so pull it afresh rather than retaining a second table.
    const cold = this.#acceptedConfigurationThroughOffset() === undefined;
    const configuration = await this.#context().subscriptionDeliveryConfiguration();
    if (!this.#reconcile(configuration.rows, configuration.throughOffset)) return;
    this.#wakeByRunner.clear(); // the alarm spent the prior claim; a runner reclaims only if it still needs one
    this.#restorePersistedWakes(configuration.rows);
    for (const row of configuration.rows) {
      if (!row.halted)
        this.#runners
          .get(`${row.name}@${row.configuredAtOffset}`)
          ?.drive((work) => this.#runInBackground(work));
    }
    if (cold) {
      this.#syncClaim();
      await this.#backgroundClaims.flush();
    }
  }

  /** Platform-only operational view: cursor offsets and bounded retry state, never event bodies. */
  async deliverySnapshots(): Promise<
    Record<string, ReturnType<DurableDeliveryProcessor["snapshot"]>>
  > {
    if (this.#runners.size === 0) {
      const configuration = await this.#context().subscriptionDeliveryConfiguration();
      this.#reconcile(configuration.rows, configuration.throughOffset);
    }
    return Object.fromEntries([...this.#runners].map(([key, runner]) => [key, runner.snapshot()]));
  }

  /** Platform operational state for the context's bounded durable-delivery resources. It is reached
   * only through IterateContextDurableObject's native diagnostic, never an itx/client capability. */
  deliveryResourceSnapshot(): {
    pendingEphemeralChars: number;
  } {
    return {
      pendingEphemeralChars: this.#pendingEphemeralChars,
    };
  }

  #reconcile(rows: DurableSubscriptionConfig[], throughOffset: number): boolean {
    const acceptedThroughOffset = this.#acceptedConfigurationThroughOffset();
    if (acceptedThroughOffset !== undefined && throughOffset < acceptedThroughOffset) return false;
    this.#configurationThroughOffset = throughOffset;
    // The facet KV owns cursors only. Core remains the durable authority for row identity and
    // configuration, which the caller supplies afresh on every push or revive.
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
    if (this.#needsCursorSweep) {
      this.#deleteUnownedCursorKeys(live);
      this.#needsCursorSweep = false;
    }
    for (const row of rows) {
      const key = `${row.name}@${row.configuredAtOffset}`;
      let runner = this.#runners.get(key);
      if (!runner) {
        runner = new DurableDeliveryProcessor({
          slug: key,
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
      if (row.halted) {
        runner.halt(
          row.halted.afterOffset,
          row.halted.attempts,
          row.halted.error || "configured subscription delivery halted",
          row.resumedAtOffset,
        );
        continue;
      }
      if (
        row.resumedAtOffset !== undefined &&
        this.ctx.storage.kv.get<number>(`durable-delivery-resumed/${key}`) !== row.resumedAtOffset
      ) {
        runner.resume(row.resumedAfterOffset, row.resumedOffset, row.resumedAtOffset);
        this.ctx.storage.kv.put(`durable-delivery-resumed/${key}`, row.resumedAtOffset);
      }
    }
    return true;
  }

  /** A cold facet has no in-memory predecessor to remove, so core configuration owns this one-time sweep. */
  #deleteUnownedCursorKeys(live: Set<string>): void {
    for (const [key] of this.ctx.storage.kv.list({ prefix: "durable-delivery/" })) {
      const slug = key.slice("durable-delivery/".length);
      if (!live.has(slug)) this.ctx.storage.kv.delete(key);
    }
    for (const [key] of this.ctx.storage.kv.list({ prefix: "durable-delivery-resumed/" })) {
      const slug = key.slice("durable-delivery-resumed/".length);
      if (!live.has(slug)) this.ctx.storage.kv.delete(key);
    }
  }

  #restorePersistedWakes(rows: DurableSubscriptionConfig[]): void {
    for (const row of rows) {
      const key = `${row.name}@${row.configuredAtOffset}`;
      const cursor = this.#runners.get(key)?.snapshot();
      const fanOutWake = cursor?.fanOut?.pending.reduce<number | undefined>(
        (earliest, item) =>
          item.nextAttemptAtMs === undefined ||
          (earliest !== undefined && earliest <= item.nextAttemptAtMs)
            ? earliest
            : item.nextAttemptAtMs,
        undefined,
      );
      const wakeAt = cursor?.pending?.nextAttemptAtMs ?? fanOutWake;
      if (wakeAt !== undefined) this.#wakeByRunner.set(key, wakeAt);
    }
  }

  #acceptedConfigurationThroughOffset(): number | undefined {
    return this.#configurationThroughOffset;
  }

  #claimThroughOffset(): number {
    if (this.#configurationThroughOffset === undefined)
      throw new Error("subscription delivery claimed before configuration was accepted");
    return this.#configurationThroughOffset;
  }

  #runtimeFor(row: DurableSubscriptionConfig): DurableDeliveryRuntime {
    return {
      storage: this.ctx.storage.kv,
      // Infrastructure uses the kernel-owned context stub. It never resolves through itx,
      // so a project rewrite, provide, or jail cannot alter cursor proof or claims.
      read: async (afterOffset, limit, resumeAtOffset) =>
        await this.#context().readSubscriptionDelivery({
          name: row.name,
          configuredAtOffset: row.configuredAtOffset,
          resumeAtOffset,
          afterOffset,
          limit,
        }),
      deliver: ({ offsets, range, resumeAtOffset }) =>
        this.#context().deliverConfiguredSubscription({
          name: row.name,
          configuredAtOffset: row.configuredAtOffset,
          resumeAtOffset,
          range,
          offsets,
        }),
      deliverEphemeral: ({ event, resumeAtOffset }) =>
        this.#context().deliverConfiguredEphemeralSubscription({
          name: row.name,
          configuredAtOffset: row.configuredAtOffset,
          resumeAtOffset,
          event,
        }),
      scheduleWake: async (atMs) => {
        const key = `${row.name}@${row.configuredAtOffset}`;
        if (atMs === null) this.#wakeByRunner.delete(key);
        else this.#wakeByRunner.set(key, atMs);
        this.#syncClaim();
      },
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

  #runInBackground(work: () => Promise<unknown>): void {
    this.#backgroundClaims.started();
    this.ctx.waitUntil(
      Promise.resolve()
        .then(work)
        .catch((error) =>
          reportIssue("subscription-delivery.facet-background", error, {
            context: this.ctx.props.iterateContextName,
          }),
        )
        .finally(() => {
          this.#backgroundClaims.settled();
          this.#syncClaim();
        }),
    );
  }

  #syncClaim(): void {
    const wakeAt = [...this.#wakeByRunner.values()].reduce<number | null>(
      (earliest, at) => (earliest === null || at < earliest ? at : earliest),
      null,
    );
    const busyAt = this.#backgroundClaims.inFlight > 0 ? Date.now() + 20_000 : null;
    this.#backgroundClaims.at(
      busyAt === null || wakeAt === null ? (busyAt ?? wakeAt) : Math.min(busyAt, wakeAt),
    );
  }
}
