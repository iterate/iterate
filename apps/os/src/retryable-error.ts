// src/retryable-error.ts — the one reader of workerd's transport-failure flag, for every holder of a
// Workers-RPC stub in apps/os.

/** The call failed at the TRANSPORT — workerd stamps `retryable: true` on every DISCONNECTED
 *  failure (jsg/util.c++: "Network connection lost.", a Durable Object reset) — and a stub whose
 *  transport is gone fails every later call the same way (Cloudflare, error handling: "avoid reusing
 *  a stub after it throws an exception … create a new one"). A coded refusal or the callee's own
 *  throw is not a transport failure. */
export const isRetryableTransportError = (error: unknown): boolean =>
  (error as { retryable?: unknown } | null)?.retryable === true;
