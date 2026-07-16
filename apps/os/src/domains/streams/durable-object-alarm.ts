/**
 * Multiplex independent desires onto a Durable Object's single platform
 * alarm. Storage reads/writes are serialized so a later request can never
 * overwrite an earlier one after an await.
 */
export class DurableObjectAlarm {
  readonly #ctx: DurableObjectState;
  readonly #diagnosticContext: { projectId: string | null; streamId: string };
  readonly #slices = new Map<string, number>();
  #chain: Promise<void> = Promise.resolve();
  #platformAlarmAt: number | null | undefined;

  constructor(
    ctx: DurableObjectState,
    diagnosticContext: { projectId: string | null; streamId: string },
  ) {
    this.#ctx = ctx;
    this.#diagnosticContext = diagnosticContext;
  }

  set(name: string, at: number | null): Promise<void> {
    this.#setDesired(name, at);
    return this.reconcile();
  }

  /** Fire-and-forget minimum for producers which can race under one owner name. */
  scheduleNoLaterThan(name: string, at: number): void {
    const current = this.#slices.get(name);
    if (current === undefined || at < current) this.#slices.set(name, at);
    const scheduled = this.reconcile().catch((error: unknown) => {
      // setAlarm/deleteAlarm are storage writes. Keep their rejection on the
      // invocation so the Durable Object output gate fails and Cloudflare
      // restarts the object instead of acknowledging work without a wake-up.
      // The structured line adds stream identity; it never converts failure
      // into success.
      try {
        console.error({
          schema: "iterate.stream-alarm.v1",
          message: "stream_alarm_reconciliation_failed",
          operation: "stream.reconcile_alarm",
          outcome: "failed",
          errorName: error instanceof Error ? error.name : "NonErrorThrowable",
          ...this.#diagnosticContext,
        });
      } catch {
        // Preserve the storage failure even if optional diagnostics fail.
      }
      throw error;
    });
    this.#ctx.waitUntil(scheduled);
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
    this.#chain = step.catch(() => {
      this.#platformAlarmAt = undefined;
    });
    return step;
  }

  #setDesired(name: string, at: number | null): void {
    if (at === null) this.#slices.delete(name);
    else this.#slices.set(name, at);
  }
}
