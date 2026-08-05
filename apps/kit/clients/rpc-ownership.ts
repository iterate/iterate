import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";

/** Read the useful fields from one RPC result, then release its wrapper. */
export async function withRpcResult<T, R>(promise: Promise<T>, read: (result: T) => R): Promise<R> {
  const result = await promise;
  try {
    return read(result);
  } finally {
    disposeIgnoredRpcResult(result);
  }
}

/** Await an RPC whose payload is intentionally ignored, then release it. */
export async function discardRpcResult(promise: Promise<unknown>): Promise<void> {
  disposeIgnoredRpcResult(await promise);
}

/** Close the domain resource and release the RPC capability that owns it. */
export function closeAndDisposeRpcHandle(handle: { close(): void }): void {
  try {
    handle.close();
  } finally {
    disposeIgnoredRpcResult(handle);
  }
}

/**
 * Owns fire-and-observe RPC results until they settle.
 *
 * Every observed promise has exactly one fulfillment path, which disposes the
 * result even when the optional observer throws. drain() makes process exit a
 * real ownership boundary instead of abandoning in-flight remote references.
 */
export class RpcResultObserver {
  readonly #pending = new Set<Promise<void>>();
  readonly #onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  observe<T>(promise: Promise<T>, onFulfilled?: (result: T) => void): void {
    const owned = promise
      .then((result) => {
        try {
          onFulfilled?.(result);
        } finally {
          disposeIgnoredRpcResult(result);
        }
      })
      .catch((error: unknown) => {
        this.#onError(error);
      });
    this.#pending.add(owned);
    void owned.finally(() => {
      this.#pending.delete(owned);
    });
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all(this.#pending);
    }
  }
}
