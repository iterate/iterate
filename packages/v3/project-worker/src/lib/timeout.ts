// lib/timeout.ts — race a promise against a deadline. The timer is CLEARED on every exit: a leaked
// timer per call would pin a Durable Object awake. A loss rejects with code TIMEOUT so a caller can
// tell "took too long" from the call's own failure (the DO's facet watchdog aborts the facet on it).

import { codedError } from "./errors.ts";

export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(codedError("TIMEOUT", `${what}: no answer in ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
