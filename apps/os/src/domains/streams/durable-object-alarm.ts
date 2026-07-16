/** Serializes ordinary alarm arms with the currently running alarm turn. */
export class DurableObjectAlarm {
  readonly #ctx: DurableObjectState;
  readonly #diagnosticContext: { projectId: string | null; streamId: string };
  #chain = Promise.resolve();
  #generation = 0;
  #running = false;

  constructor(
    ctx: DurableObjectState,
    diagnosticContext: { projectId: string | null; streamId: string },
  ) {
    this.#ctx = ctx;
    this.#diagnosticContext = diagnosticContext;
  }

  /** Between alarm turns, move the platform alarm earlier but never later. */
  armNoLaterThan(at: number): void {
    const generation = this.#generation;
    const armed = this.#enqueue(async () => {
      if (!this.#mayArm(generation)) return;
      const current = await this.#ctx.storage.getAlarm();
      if (!this.#mayArm(generation)) return;
      if (current === null || at < current) await this.#ctx.storage.setAlarm(at);
    }).catch((error: unknown) => {
      emitAlarmError(error, this.#diagnosticContext);
      throw error;
    });
    this.#ctx.waitUntil(armed);
  }

  /** Suppress constructor and background arms as the first line of alarm(). */
  begin(): void {
    this.#generation += 1;
    this.#running = true;
  }

  /** Replace the consumed alarm with the exact deadline derived from durable owner state. */
  complete(exactAt: number | null): Promise<void> {
    this.#generation += 1;
    return this.#enqueue(async () => {
      if (exactAt === null) await this.#ctx.storage.deleteAlarm();
      else await this.#ctx.storage.setAlarm(exactAt);
      this.#running = false;
    });
  }

  #mayArm(generation: number): boolean {
    return generation === this.#generation && !this.#running;
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const step = this.#chain.then(work);
    this.#chain = step.catch(() => undefined);
    return step;
  }
}

function emitAlarmError(
  error: unknown,
  context: { projectId: string | null; streamId: string },
): void {
  try {
    console.error({
      schema: "iterate.stream-alarm.v1",
      message: "stream_alarm_arm_failed",
      operation: "stream.arm_alarm",
      outcome: "failed",
      errorName: error instanceof Error ? error.name : "NonErrorThrowable",
      ...context,
    });
  } catch {
    // Preserve the storage failure if optional diagnostics fail.
  }
}
