/**
 * Multiplex independent desires onto a Durable Object's single platform
 * alarm. Storage reads/writes are serialized so a later request can never
 * overwrite an earlier one after an await.
 */
export class DurableObjectAlarm {
  readonly #ctx: DurableObjectState;
  readonly #slices = new Map<string, number>();
  #chain: Promise<void> = Promise.resolve();
  #platformAlarmAt: number | null | undefined;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
  }

  set(name: string, at: number | null): Promise<void> {
    if (at === null) this.#slices.delete(name);
    else this.#slices.set(name, at);
    return this.reconcile();
  }

  /** Fire-and-forget form for synchronous product paths; reconciliation owns diagnostics. */
  schedule(name: string, at: number | null): void {
    void this.set(name, at).catch(() => undefined);
  }

  /** Record that the platform consumed this alarm and drop every due slice. */
  fired(at = Date.now()): Promise<void> {
    return this.#enqueue(() => {
      this.#platformAlarmAt = null;
      for (const [name, desiredAt] of this.#slices) {
        if (desiredAt <= at) this.#slices.delete(name);
      }
      return Promise.resolve();
    });
  }

  reconcile(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#platformAlarmAt === undefined) {
        const inherited = await this.#ctx.storage.getAlarm();
        this.#platformAlarmAt = inherited;
        if (inherited !== null) this.#slices.set("@inherited", inherited);
      }

      let earliest: number | null = null;
      for (const at of this.#slices.values()) {
        if (earliest === null || at < earliest) earliest = at;
      }
      if (earliest === this.#platformAlarmAt) return;

      this.#platformAlarmAt = earliest;
      if (earliest === null) await this.#ctx.storage.deleteAlarm();
      else await this.#ctx.storage.setAlarm(earliest);
    });
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const step = this.#chain.then(work);
    this.#chain = step.catch((error: unknown) => {
      this.#platformAlarmAt = undefined;
      console.error("stream alarm reconciliation failed", error);
    });
    this.#ctx.waitUntil(this.#chain);
    return step;
  }
}
