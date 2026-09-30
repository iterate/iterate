import {
  DurableDeliveryProcessor,
  type DurableDeliveryCursor,
  type DurableDeliveryRuntime,
} from "iterate/stream/durable-delivery";
import { consumesEvent, type ScannedRange, type StreamEvent } from "iterate/stream/processor";

export type DurableSubscriptionRow = {
  name: string;
  configuredAtOffset: number;
  consumes?: string[];
  afterOffset?: number;
  ordered?: false;
  resumedAtOffset?: number;
  resumedAfterOffset?: number;
  resumedOffset?: number;
  halted?: { afterOffset: number; attempts: number; error?: string };
  maxAttempts?: number;
  retryCapMs?: number;
};

type Page = { offsets: number[]; scannedThroughOffset: number; atHead: boolean };

type Deps = {
  storage: DurableObjectStorage["kv"];
  rows: () => DurableSubscriptionRow[];
  currentHead: () => number;
  read: (row: DurableSubscriptionRow, after: number, limit: number, resume?: number) => Page;
  deliver: (
    row: DurableSubscriptionRow,
    input: { offsets: number[]; range: ScannedRange; resumeAtOffset?: number },
  ) => Promise<void>;
  deliverEphemeral: (
    row: DurableSubscriptionRow,
    input: { offset: number; type: string; resumeAtOffset?: number },
  ) => Promise<void>;
  terminal: (
    row: DurableSubscriptionRow,
    input: {
      afterOffset: number;
      attempts: number;
      error: string;
      fanOut?: true;
      resumeAtOffset?: number;
    },
  ) => Promise<void>;
  run: (work: () => Promise<unknown>) => void;
  wakesChanged: () => void;
};

/** Context-owned durable cursors. Core owns row identity and context KV owns progress. */
export class DurableSubscriptionDelivery {
  readonly #deps: Deps;
  readonly #runners = new Map<string, DurableDeliveryProcessor>();
  readonly #wakeByRunner = new Map<string, number>();
  /** A persisted pending attempt has no in-memory promise after a cold start. */
  readonly #coldRecovery = new Set<string>();
  #swept = false;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  get deadline(): number | null {
    return [...this.#wakeByRunner.values()].reduce<number | null>(
      (earliest, at) => (earliest === null || at < earliest ? at : earliest),
      null,
    );
  }

  snapshots(): Record<string, DurableDeliveryCursor> {
    return Object.fromEntries([...this.#runners].map(([key, runner]) => [key, runner.snapshot()]));
  }

  sync(): void {
    this.#reconcile(this.#deps.rows());
  }

  push(rows: DurableSubscriptionRow[], events: StreamEvent[], configurationChanged: boolean): void {
    if (configurationChanged) this.#reconcile(rows);
    for (const row of rows) {
      if (row.halted) continue;
      const relevant =
        configurationChanged || events.some((event) => consumesEvent(row.consumes, event));
      if (!relevant) continue;
      const runner = this.#runners.get(keyOf(row));
      if (!runner) continue;
      for (const event of events) runner.push(event);
      runner.drive((work) => this.#deps.run(work));
    }
  }

  /** Drives all current rows after a durable recovery wake. */
  revive(): boolean {
    const rows = this.#deps.rows();
    this.#reconcile(rows);
    let drove = false;
    for (const row of rows) {
      const key = keyOf(row);
      this.#coldRecovery.delete(key);
      if (row.halted) continue;
      this.#runners.get(key)?.drive((work) => this.#deps.run(work));
      drove = true;
    }
    this.#restoreWakes();
    return drove;
  }

  #reconcile(rows: DurableSubscriptionRow[]): void {
    const live = new Set(rows.map(keyOf));
    for (const [key, runner] of this.#runners)
      if (!live.has(key)) {
        runner[Symbol.dispose]();
        this.#runners.delete(key);
        this.#wakeByRunner.delete(key);
        this.#coldRecovery.delete(key);
        this.#deps.storage.delete(`durable-delivery/${key}`);
        this.#deps.storage.delete(`durable-delivery-resumed/${key}`);
      }
    if (!this.#swept) {
      for (const [key] of this.#deps.storage.list({ prefix: "durable-delivery/" }))
        if (!live.has(key.slice("durable-delivery/".length))) this.#deps.storage.delete(key);
      for (const [key] of this.#deps.storage.list({ prefix: "durable-delivery-resumed/" }))
        if (!live.has(key.slice("durable-delivery-resumed/".length)))
          this.#deps.storage.delete(key);
      this.#swept = true;
    }
    for (const row of rows) {
      const key = keyOf(row);
      let runner = this.#runners.get(key);
      if (!runner) {
        const persisted = this.#deps.storage.get<DurableDeliveryCursor>(`durable-delivery/${key}`);
        if (
          persisted?.pending?.nextAttemptAtMs === undefined &&
          (persisted?.pending ||
            persisted?.fanOut?.pending.some((item) => item.nextAttemptAtMs === undefined))
        )
          this.#coldRecovery.add(key);
        runner = new DurableDeliveryProcessor({
          slug: key,
          consumes: row.consumes,
          afterOffset: row.afterOffset ?? row.configuredAtOffset,
          resumeAtOffset: row.resumedAtOffset,
          maxAttempts: row.maxAttempts,
          retryDelayMs: row.retryCapMs
            ? (attempt) => Math.min(1_000 * 2 ** (attempt - 1), row.retryCapMs ?? 30 * 60_000)
            : undefined,
          ...(row.ordered === false && { fanOut: true }),
          runtime: this.#runtime(row),
        });
        this.#runners.set(key, runner);
      }
      if (row.halted) {
        this.#coldRecovery.delete(key);
        runner.halt(
          row.halted.afterOffset,
          row.halted.attempts,
          row.halted.error || "configured subscription delivery halted",
          row.resumedAtOffset,
        );
      } else if (
        row.resumedAtOffset !== undefined &&
        this.#deps.storage.get<number>(`durable-delivery-resumed/${key}`) !== row.resumedAtOffset
      ) {
        runner.resume(
          row.resumedAfterOffset === undefined
            ? undefined
            : Math.min(row.resumedAfterOffset, this.#deps.currentHead()),
          row.resumedOffset,
          row.resumedAtOffset,
        );
        this.#deps.storage.put(`durable-delivery-resumed/${key}`, row.resumedAtOffset);
      }
    }
    this.#restoreWakes();
  }

  #restoreWakes() {
    this.#wakeByRunner.clear();
    for (const [key, runner] of this.#runners) {
      const cursor = runner.snapshot();
      if (cursor.halted) continue;
      const fanout = cursor.fanOut?.pending.reduce<number | undefined>(
        (at, item) =>
          item.nextAttemptAtMs === undefined || (at !== undefined && at <= item.nextAttemptAtMs)
            ? at
            : item.nextAttemptAtMs,
        undefined,
      );
      const at = cursor.pending?.nextAttemptAtMs ?? fanout;
      if (this.#coldRecovery.has(key)) this.#wakeByRunner.set(key, Date.now());
      else if (at !== undefined) this.#wakeByRunner.set(key, at);
    }
  }

  #runtime(row: DurableSubscriptionRow): DurableDeliveryRuntime {
    const key = keyOf(row);
    return {
      storage: this.#deps.storage,
      read: async (after, limit, resume) => this.#deps.read(row, after, limit, resume),
      deliver: (input) => this.#deps.deliver(row, input),
      deliverEphemeral: (input) => this.#deps.deliverEphemeral(row, input),
      terminal: (input) =>
        this.#deps.terminal(row, { ...input, error: input.error.slice(0, 1024) }),
      scheduleWake: async (at) => {
        if (at === null) this.#wakeByRunner.delete(key);
        else this.#wakeByRunner.set(key, at);
        this.#deps.wakesChanged();
      },
    };
  }
}

function keyOf(row: DurableSubscriptionRow) {
  return `${row.name}@${row.configuredAtOffset}`;
}
