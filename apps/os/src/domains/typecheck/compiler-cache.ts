// One tswasm compiler per isolate, shared across checks — with the one
// invalidation the memoization must have: a compiler that DIED mid-compile is
// dropped, so the next check re-instantiates instead of reusing a corpse.
//
// The failure this closes (seen live in prd): the typescript-go wasm program
// can exit permanently mid-`compile()` ("Go program has already exited"). The
// old memoization only re-created the compiler when INSTANTIATION rejected, so
// a post-instantiation death was cached forever — every later check returned
// the crash diagnostic, which the execution gate reads as "unchecked" and
// runs. That fails the gate OPEN durably (all projects share one sidecar
// isolate) until traffic quiets enough for the isolate to be evicted.
//
// Kept free of cloudflare imports so it is unit-testable with a fake factory.

/** A compiler cache: `get()` returns the shared instance (creating it once),
 * `resetIfCurrent()` drops it so the next `get()` re-creates — call it when a
 * compile crashed on the promise you were holding. */
export interface CompilerCache<C> {
  get(): Promise<C>;
  resetIfCurrent(promise: Promise<C>): void;
}

export function createCompilerCache<C>(factory: () => Promise<C>): CompilerCache<C> {
  let current: Promise<C> | undefined;
  return {
    get() {
      const promise = (current ??= factory());
      // A failed INSTANTIATION must not be cached — caching the rejection would
      // poison every later get() until isolate death. Only clear if we are
      // still the owner (a concurrent get() may already have replaced it).
      promise.catch(() => {
        if (current === promise) current = undefined;
      });
      return promise;
    },
    resetIfCurrent(promise) {
      if (current === promise) current = undefined;
    },
  };
}
