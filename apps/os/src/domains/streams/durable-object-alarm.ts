/** Serializes shared Durable Object alarm writes and exposes failures to Cloudflare. */
export class DurableObjectAlarm {
  readonly #ctx: DurableObjectState;
  readonly #diagnosticContext: { projectId: string | null; streamId: string };
  #chain = Promise.resolve();

  constructor(
    ctx: DurableObjectState,
    diagnosticContext: { projectId: string | null; streamId: string },
  ) {
    this.#ctx = ctx;
    this.#diagnosticContext = diagnosticContext;
  }

  /** Move the platform alarm earlier, never later. Concurrent arms run in order. */
  armNoLaterThan(at: number): void {
    const armed = this.#chain.then(async () => {
      const current = await this.#ctx.storage.getAlarm();
      if (current === null || at < current) await this.#ctx.storage.setAlarm(at);
    });
    this.#chain = armed.catch(() => undefined);
    this.#ctx.waitUntil(
      armed.catch((error: unknown) => {
        emitAlarmError(error, this.#diagnosticContext);
        throw error;
      }),
    );
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
