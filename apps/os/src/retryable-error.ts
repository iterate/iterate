// src/retryable-error.ts — the one reader of workerd's failure flags (a transport cut, a Durable
// Object reset), for every holder of a Workers-RPC stub in apps/os.

/** The call failed at the TRANSPORT — workerd stamps `retryable: true` on every DISCONNECTED
 *  failure (jsg/util.c++: "Network connection lost.", a Durable Object reset) — and a stub whose
 *  transport is gone fails every later call the same way (Cloudflare, error handling: "avoid reusing
 *  a stub after it throws an exception … create a new one"). A coded refusal or the callee's own
 *  throw is not a transport failure. */
export const isRetryableTransportError = (error: unknown): boolean =>
  (error as { retryable?: unknown } | null)?.retryable === true;

/** A transport failure a DEPLOY caused: every deploy resets the platform's Durable Objects for their
 *  new code, and workerd fails each call in flight with this message. Expected on every deploy
 *  under traffic, so a retry it causes is no platform failure (scripts/ci/prd-fault-alarm.ts, which
 *  excludes the same message from its errors). */
export const isDeployReset = (error: unknown): boolean =>
  isRetryableTransportError(error) &&
  error instanceof Error &&
  error.message.includes("Durable Object reset because its code was updated");

/** The Durable Object was reset under the call because its STORAGE failed: "Durable Object storage
 *  operation exceeded timeout which caused object to be reset." (workerd io/worker.c++: a storage
 *  operation held the output gate 30 s; the failure is stamped `overloaded`, not `retryable`) or
 *  "Internal error in Durable Object storage caused object to be reset; reference = …" (the storage
 *  service's own). workerd stamps every such `broken.` failure `durableObjectReset`
 *  (jsg/exception.c++), and the next call reaches a fresh instance. A reset for any other reason —
 *  the isolate's memory limit, a constructor that threw — is not the platform's failure. */
const isDurableObjectStorageReset = (error: unknown): boolean =>
  error instanceof Error &&
  "durableObjectReset" in error &&
  error.durableObjectReset === true &&
  /Durable Object storage\b.*\bcaused object to be reset/.test(error.message);

/** A failure of the platform's own that the same call on a fresh stub gets past: the transport cut
 *  ("Network connection lost.") or a storage reset. A deploy's reset is expected, not the platform's
 *  failure, so it is not this: a repeat of it would log a platform-failure heal on every deploy. */
export const isPlatformFailure = (error: unknown): boolean =>
  (isRetryableTransportError(error) || isDurableObjectStorageReset(error)) && !isDeployReset(error);
