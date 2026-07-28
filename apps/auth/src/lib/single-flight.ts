/**
 * Collapse concurrent calls for one key into one in-flight operation.
 *
 * OAuth refresh tokens rotate on use. Sharing the refresh promise prevents
 * parallel requests with the same cookie from presenting the old refresh
 * token twice and triggering reuse revocation for the whole session family.
 */
export function createSingleFlight<T>(): (key: string, fn: () => Promise<T>) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (key, fn) => {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const flight = (async () => {
      try {
        return await fn();
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, flight);
    return flight;
  };
}
