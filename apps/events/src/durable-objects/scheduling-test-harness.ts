/**
 * Test-only durable objects for the scheduler suite.
 *
 * Keep these out of the production worker entry so the runtime worker only
 * carries the scheduler itself, not test counters or harness-only methods.
 */
export function createSchedulingTestDurableObjects<TBase extends new (...args: any[]) => object>(
  Base: TBase,
) {
  class TestScheduleStreamDurableObject extends Base {
    readonly schedulableCallbacks = [
      "testCallback",
      "intervalCallback",
      "throwingCallback",
      "slowCallback",
      "cronCallback",
    ] as const;

    intervalCallbackCount = 0;
    slowCallbackExecutionCount = 0;
    slowCallbackStartTimes: number[] = [];
    slowCallbackEndTimes: number[] = [];

    testCallback() {}

    intervalCallback() {
      this.intervalCallbackCount++;
    }

    throwingCallback() {
      throw new Error("Intentional test error");
    }

    async slowCallback() {
      this.slowCallbackExecutionCount++;
      this.slowCallbackStartTimes.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 500));
      this.slowCallbackEndTimes.push(Date.now());
    }

    cronCallback() {}

    async getStoredAlarm() {
      return (this as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm();
    }

    async clearStoredAlarm() {
      await (this as unknown as { ctx: DurableObjectState }).ctx.storage.deleteAlarm();
    }
  }

  return {
    TestScheduleStreamDurableObject,
  };
}
