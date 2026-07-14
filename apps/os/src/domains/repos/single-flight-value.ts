/**
 * One invalidatable async value. Concurrent callers share the same load and a
 * rejected load is never retained. `clear()` generation-fences older loads so
 * their late rejection cannot evict the replacement value.
 */
export class SingleFlightValue<T> {
  #promise: Promise<T> | undefined;

  get(load: () => Promise<T>): Promise<T> {
    if (this.#promise !== undefined) return this.#promise;
    const promise = load().catch((error: unknown) => {
      if (this.#promise === promise) this.#promise = undefined;
      throw error;
    });
    this.#promise = promise;
    return promise;
  }

  clear(): void {
    this.#promise = undefined;
  }
}
