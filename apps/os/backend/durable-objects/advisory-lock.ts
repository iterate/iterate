import { initTRPC, TRPCError } from "@trpc/server";
import { DurableObject } from "cloudflare:workers";
import Mutex from "p-suite/p-mutex";

/**
 * Advisory Lock Durable Object
 *
 * Inspired by PostgreSQL advisory locks: https://www.postgresql.org/docs/9.1/functions-admin.html
 *
 * Each Durable Object instance represents a single lock. Use the DO name to identify the resource.
 *
 * Provides distributed locking with RPC methods:
 * - acquire(timeout?): Acquire lock, wait if necessary (default timeout: 30s, use 0 for immediate)
 * - release(): Release lock
 * - isLocked(): Check if lock is held
 *
 * Usage:
 * ```ts
 * const lockKey = "my-resource:operation-123";
 * const stub = env.ADVISORY_LOCK.idFromName(lockKey);
 * const lock = env.ADVISORY_LOCK.get(stub);
 *
 * // Blocking acquire with timeout
 * const acquired = await lock.acquire();
 * if (acquired) {
 *   try {
 *     // do work
 *   } finally {
 *     await lock.release();
 *   }
 * }
 *
 * // Non-blocking try (timeout=0)
 * const acquired = await lock.acquire(0);
 * ```
 */
export class AdvisoryLock extends DurableObject {
  private mutex = new Mutex();

  static trpcPlugin(params: { onFailure?: () => never; timeout?: number } = {}) {
    return initTRPC
      .context<{
        advisoryLockKey: string;
        env: { ADVISORY_LOCK: DurableObjectNamespace<AdvisoryLock> };
      }>()
      .create()
      .procedure.use(async ({ ctx, next }) => {
        const { advisoryLockKey, env } = ctx;
        const stub = env.ADVISORY_LOCK.get(env.ADVISORY_LOCK.idFromName(advisoryLockKey));
        const result = await AdvisoryLock.runWithLock(stub, next, params.timeout);
        if (!result.success) {
          if (params.onFailure) params.onFailure();
          throw new TRPCError({
            code: "CONFLICT",
            message: `A lock is already held for key ${advisoryLockKey}`,
          });
        }
        return result.data;
      });
  }

  static async runWithLock<T>(
    /** The stub to the AdvisoryLock Durable Object. */
    stub: DurableObjectStub<AdvisoryLock>,
    /** Function to run once the lock is acquired. Will be wrapped in a try/finally block to release the lock. */
    fn: () => Promise<T>,
    /** Max time to wait for the lock. If set to 0, the lock will be acquired immediately or return null if not available. */
    timeout = 0,
  ) {
    try {
      const acquired = await stub.acquire(timeout);
      if (!acquired) {
        return { success: false } as const;
      }

      const data = await fn();
      return { success: true, data } as const;
    } finally {
      await stub.release();
    }
  }

  /**
   * Acquire the lock, waiting if necessary
   * @param timeout - Maximum time to wait in milliseconds (default: 30000, use 0 for immediate/non-blocking)
   * @returns true if lock acquired, false if timeout
   */
  async acquire(timeout: number): Promise<boolean> {
    // Create a timeout promise
    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeout);
    });

    // Race between acquiring lock and timeout
    return Promise.race([this.mutex.lock().then(() => true), timeoutPromise]);
  }

  /**
   * Release the lock
   * @returns true if lock was released, false if not held
   */
  async release(): Promise<boolean> {
    if (!this.mutex.isLocked) {
      return false;
    }

    this.mutex.unlock();
    return true;
  }

  /**
   * Check if the lock is currently held
   * @returns true if locked, false otherwise
   */
  async isLocked(): Promise<boolean> {
    return this.mutex.isLocked;
  }
}
