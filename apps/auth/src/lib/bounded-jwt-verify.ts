/** A native JWT verification failed to settle inside every bounded attempt. */
export class JwtVerificationDeadlineError extends Error {
  override readonly name = "JwtVerificationDeadlineError";
}

// Local RS256 verification normally settles in a few milliseconds. During a
// preview e2e run, one document request instead spent 99,989ms canceled with
// 1ms of Worker CPU and no child fetch/RPC span: the request stranded at the
// first native async boundary before SSR. Verification is pure, so a sparse
// fresh attempt is safe; the deadline prevents one bad native promise from
// owning the whole request indefinitely.
const JWT_VERIFY_ATTEMPT_TIMEOUTS_MS = [250, 750, 2_000] as const;

/**
 * Verify through sparse, bounded fresh attempts only when an attempt does not
 * settle. Explicit verification failures retain their original semantics and
 * are never retried. Timed-out promises remain observed by Promise.race, so a
 * late rejection cannot become unhandled.
 */
export async function verifyJwtWithBoundedHedges<T>(input: {
  verify: () => Promise<T>;
  tokenKind: "access" | "bearer" | "id";
  /** Internal deterministic test seam; production always uses the constants above. */
  attemptTimeoutsMs?: readonly number[];
}): Promise<T> {
  const attemptTimeoutsMs = input.attemptTimeoutsMs ?? JWT_VERIFY_ATTEMPT_TIMEOUTS_MS;
  if (attemptTimeoutsMs.length === 0 || attemptTimeoutsMs.some((timeoutMs) => timeoutMs <= 0)) {
    throw new Error("JWT verification attempt timeouts must be positive.");
  }

  const startedAt = Date.now();
  for (const [index, timeoutMs] of attemptTimeoutsMs.entries()) {
    const attempt = index + 1;
    const timeout = Symbol("jwt-verification-attempt-timeout");
    const verification = Promise.resolve().then(input.verify);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      verification,
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    if (outcome !== timeout) {
      if (attempt > 1) {
        console.warn("JWT verification completed after a bounded hedge", {
          attempt,
          elapsedMs: Date.now() - startedAt,
          tokenKind: input.tokenKind,
        });
      }
      return outcome;
    }

    if (attempt < attemptTimeoutsMs.length) {
      console.warn("JWT verification exceeded its hedge threshold", {
        attempt: attempt + 1,
        attemptTimeoutMs: timeoutMs,
        elapsedMs: Date.now() - startedAt,
        tokenKind: input.tokenKind,
      });
    }
  }

  const deadlineMs = attemptTimeoutsMs.reduce((total, timeoutMs) => total + timeoutMs, 0);
  console.error("JWT verification exhausted its bounded deadline", {
    attempts: attemptTimeoutsMs.length,
    deadlineMs,
    elapsedMs: Date.now() - startedAt,
    tokenKind: input.tokenKind,
  });
  throw new JwtVerificationDeadlineError(
    `${input.tokenKind} JWT verification exceeded ${deadlineMs}ms.`,
  );
}
