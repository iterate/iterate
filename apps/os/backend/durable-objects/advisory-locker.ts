import { initTRPC, TRPCError } from "@trpc/server";
import { DurableObject } from "cloudflare:workers";

export class AdvisoryLocker extends DurableObject {
  private _isLocked = false;

  static trpcWithLocker = initTRPC
    .context<{
      advisoryLockKey: string;
      env: { ADVISORY_LOCKER: DurableObjectNamespace<AdvisoryLocker> };
    }>()
    .create()
    .procedure.use(({ ctx, next }) => {
      console.log("trpcWithLocker middleware running", ctx.advisoryLockKey);
      return next({
        ctx: {
          lockStub: ctx.env.ADVISORY_LOCKER.get(
            ctx.env.ADVISORY_LOCKER.idFromName(ctx.advisoryLockKey),
          ),
        },
      });
    });
  static trpcPlugin(params: { onFailure?: () => never } = {}) {
    return AdvisoryLocker.trpcWithLocker.use(async ({ ctx, next }) => {
      const result = await AdvisoryLocker.runWithLock(ctx.lockStub, next);
      if (!result.success) {
        if (params.onFailure) params.onFailure();
        throw new TRPCError({
          code: "CONFLICT",
          message: `A lock is already held for key ${ctx.advisoryLockKey}`,
        });
      }
      return result.data;
    });
  }

  static async runWithLock<T>(
    /** The stub to the AdvisoryLock Durable Object. */
    stub: DurableObjectStub<AdvisoryLocker>,
    /** Function to run once the lock is acquired. Will be wrapped in a try/finally block to release the lock. */
    fn: () => Promise<T>,
  ) {
    const success = await stub.tryAcquire();
    if (!success) {
      return { success: false } as const;
    }
    const data = await fn().finally(() => stub.release());
    return { success: true, data } as const;
  }

  tryAcquire() {
    if (this._isLocked) return false;
    this._isLocked = true;
    return true;
  }

  /**
   * @returns true if lock was released, false if not held
   */
  async release() {
    let old = this._isLocked;
    this._isLocked = false;
    return !old;
  }

  async isLocked() {
    return this._isLocked;
  }
}
