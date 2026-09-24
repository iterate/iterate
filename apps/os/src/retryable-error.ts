// src/retryable-error.ts — the one reader of workerd's transport-failure flag, for every holder of a
// Workers-RPC stub in apps/os.

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
