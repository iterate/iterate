import {
  DurableDeliveryProcessor,
  type DurableDeliveryCursor,
  type DurableDeliveryRuntime,
} from "iterate/stream/durable-delivery";
import { consumesEvent, type StreamEvent } from "iterate/stream/processor";
import type { Subscription } from "../stream/core-processor.ts";

export type DurableSubscriptionRow = Omit<Subscription, "target" | "delivery" | "hostedFacet"> & {
  name: string;
};

type Page = Awaited<ReturnType<DurableDeliveryRuntime["read"]>>;

// Every durable target uses the same bounded ladder, so live rule edits cannot change the retry
// policy for an admitted cursor.
const durableDeliveryMaxAttempts = 25;

type Deps = {
  storage: DurableObjectStorage["kv"];
  rows: () => DurableSubscriptionRow[];
  currentHead: () => number;
  read: (row: DurableSubscriptionRow, after: number, limit: number, resume?: number) => Page;
  deliver: (
    row: DurableSubscriptionRow,
    input: Parameters<DurableDeliveryRuntime["deliver"]>[0],
  ) => Promise<void>;
  deliverEphemeral: (
    row: DurableSubscriptionRow,
    input: Parameters<DurableDeliveryRuntime["deliverEphemeral"]>[0],
  ) => Promise<void>;
  terminal: (
    row: DurableSubscriptionRow,
    input: Parameters<DurableDeliveryRuntime["terminal"]>[0],
  ) => Promise<void>;
  run: (work: () => Promise<unknown>) => void;
  wakesChanged: () => void;
};

/** Context-owned durable cursors. Core owns row identity and context KV owns progress. */
export class DurableSubscriptionDelivery {
  readonly #deps: Deps;
  readonly #runners = new Map<string, DurableDeliveryProcessor>();
  readonly #wakeByRunner = new Map<string, number>();
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
    return Object.fromEntries(
      this.#deps.rows().map((row) => [
        keyOf(row),
        this.#deps.storage.get<DurableDeliveryCursor>(`durable-delivery/${keyOf(row)}`) ?? {
          confirmedOffset: row.afterOffset ?? row.configuredAtOffset,
        },
      ]),
    );
  }

  sync(): void {
    this.#reconcile(this.#deps.rows());
  }

  push(rows: DurableSubscriptionRow[], events: StreamEvent[], configurationChanged: boolean): void {
    const fresh = this.#reconcile(rows);
    for (const row of rows) {
      if (row.halted) continue;
      const key = keyOf(row);
      const relevant =
        configurationChanged ||
        fresh.has(key) ||
        events.some(
          (event) =>
            consumesEvent(row.consumes, event) && (!event.ephemeral || row.ordered !== false),
        );
      if (!relevant) continue;
      const runner = this.#runners.get(key);
      if (!runner) continue;
      for (const event of events) runner.push(event);
      this.#drive(key);
    }
  }

  /** Drives all current rows after a durable recovery wake. */
  revive(): boolean {
    const rows = this.#deps.rows();
    this.#reconcile(rows);
    let drove = false;
    for (const row of rows) {
      const key = keyOf(row);
      if (row.halted) continue;
      this.#drive(key);
      drove = true;
    }
    return drove;
  }

  #drive(key: string): void {
    this.#wakeByRunner.delete(key);
    this.#runners.get(key)?.drive((work) => this.#deps.run(work));
  }

  #reconcile(rows: DurableSubscriptionRow[]): Set<string> {
    const fresh = new Set<string>();
    const live = new Set(rows.map(keyOf));
    for (const [key, runner] of this.#runners)
      if (!live.has(key)) {
        runner[Symbol.dispose]();
        this.#runners.delete(key);
        this.#wakeByRunner.delete(key);
        this.#deps.storage.delete(`durable-delivery/${key}`);
      }
    if (!this.#swept) {
      for (const [key] of this.#deps.storage.list({ prefix: "durable-delivery/" }))
        if (!live.has(key.slice("durable-delivery/".length))) this.#deps.storage.delete(key);
      this.#swept = true;
    }
    for (const row of rows) {
      const key = keyOf(row);
      let runner = this.#runners.get(key);
      const cursor = this.#deps.storage.get<DurableDeliveryCursor>(`durable-delivery/${key}`);
      if (!runner) {
        runner = new DurableDeliveryProcessor({
          slug: key,
          consumes: row.consumes,
          afterOffset: row.afterOffset ?? row.configuredAtOffset,
          resumeAtOffset: row.resumed?.atOffset,
          maxAttempts: durableDeliveryMaxAttempts,
          retryDelayMs: (attempt) => Math.min(1_000 * 2 ** (attempt - 1), 4 * 60 * 60_000),
          ...(row.ordered === false && { fanOut: true }),
          runtime: this.#runtime(row),
        });
        this.#runners.set(key, runner);
        fresh.add(key);
      }
      if (row.halted) {
        this.#wakeByRunner.delete(key);
        runner.halt(
          row.halted.afterOffset,
          row.halted.attempts,
          row.halted.error || "configured subscription delivery halted",
          row.resumed?.atOffset,
        );
      } else if (row.resumed && cursor?.resumeAtOffset !== row.resumed.atOffset) {
        runner.resume(
          row.resumed.afterOffset === undefined
            ? undefined
            : Math.min(row.resumed.afterOffset, this.#deps.currentHead()),
          row.resumed.offset,
          row.resumed?.atOffset,
        );
      }
    }
    return fresh;
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
