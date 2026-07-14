const SERIALIZED_RPC_VALUE_TOO_LARGE = "Serialized RPC arguments or return values are limited";

/**
 * Read one catch-up page, reducing only an RPC-oversized page until it fits.
 * A single oversized event and every unrelated failure still fail closed.
 */
export async function readCatchUpPage<T>(
  limit: number,
  read: (limit: number) => Promise<T[]>,
): Promise<{ limit: number; page: T[] }> {
  let nextLimit = limit;
  for (;;) {
    try {
      return { limit: nextLimit, page: await read(nextLimit) };
    } catch (error) {
      if (
        nextLimit <= 1 ||
        !(error instanceof Error) ||
        !error.message.includes(SERIALIZED_RPC_VALUE_TOO_LARGE)
      ) {
        throw error;
      }
      nextLimit = Math.max(1, Math.floor(nextLimit / 2));
    }
  }
}
