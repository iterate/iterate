// Small standalone helpers for the browser stream runtime — no runtime state,
// safe to share and unit-test in isolation.

/** The message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The deadline lane's own error class, so catch blocks can tell "the far side
 * answered nothing" (transport suspect — a half-open socket swallows calls
 * forever) apart from "the far side answered with a failure" (transport fine,
 * reconnect is enough).
 */
export class StepTimeoutError extends Error {}

/**
 * Promise.race against a deadline, with the loser's timer cleared when the
 * race settles — a bare setTimeout-rejection branch would otherwise fire an
 * unhandled rejection after every SUCCESSFUL call.
 */
export function raceWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeoutError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Whether a SQL statement writes (so the runtime nudges its reactive queries). */
export function isWriteStatement(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|PRAGMA\s+user_version)/i.test(sql);
}
