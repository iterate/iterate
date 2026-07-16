export type DeadlineOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "deadline" };

/**
 * Observe both sides of a promise/deadline race. The losing promise keeps its
 * rejection handler, so ending the caller's execution context at the deadline
 * cannot surface a later unhandled rejection.
 */
export async function settleByDeadline<T>(
  promise: Promise<T>,
  expiresAt: number,
  now: () => number,
): Promise<DeadlineOutcome<T>> {
  const observed = promise.then<DeadlineOutcome<T>, DeadlineOutcome<T>>(
    (value) => ({ status: "fulfilled", value }),
    (error: unknown) => ({ status: "rejected", error }),
  );
  const remainingMs = expiresAt - now();
  if (remainingMs <= 0) {
    void observed;
    return { status: "deadline" };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observed,
      new Promise<DeadlineOutcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: "deadline" }), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
