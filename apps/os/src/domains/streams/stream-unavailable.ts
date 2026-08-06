// The stream capability's availability-error contract, shared by the worker
// door that MINTS the tag (StreamRpcTarget in rpc-targets.ts) and the clients
// that CLASSIFY it (the browser database writer's appendBatch retry loop). Kept
// zero-dependency on purpose: the browser bundle imports this file directly.
//
// Why a message prefix and not an error subclass or a property: the flags
// workerd puts on a Durable Object stub rejection (`durableObjectReset`,
// `retryable`, `overloaded`) are only visible in the worker that made the stub
// call — capnweb serializes `message` (and a whitelisted `name`) and strips
// everything else, and a custom subclass name downgrades to plain `Error` on
// the way through. The message prefix is the one channel every hop preserves,
// and it is ours: matching it is contract enforcement, not sniffing
// Cloudflare-internal strings whose wording can change under us.

/**
 * Prefix on rejections from stream capability calls that failed because the
 * stream's Durable Object incarnation died mid-call — explicit `kill()`,
 * eviction, deploy reset, overload — rather than because the call itself was
 * bad. By contract these are RETRYABLE: the incarnation reboots on the next
 * call, and appends carry idempotency keys, so a batch that
 * committed-but-lost-its-ack dedupes on retry instead of double-appending.
 */
export const STREAM_UNAVAILABLE_MESSAGE_PREFIX = "stream-unavailable: ";

/**
 * Identifies the stream DO's own one-shot waiter timeout across Workers RPC.
 * The public facade uses shorter one-shot waits under one caller deadline, so
 * it must distinguish an exhausted internal slice from a predicate failure.
 */
export const STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX = "stream-wait-timeout: ";

/**
 * Whether workerd rejected a Durable Object stub call because the target
 * incarnation disappeared or was temporarily unavailable, rather than
 * because application code threw. Keep this classifier local and
 * dependency-free: the browser stream database imports this module directly.
 */
export function isDurableObjectLifecycleError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const flags = error as {
    durableObjectReset?: unknown;
    overloaded?: unknown;
    retryable?: unknown;
  };
  if (flags.durableObjectReset === true || flags.overloaded === true || flags.retryable === true) {
    return true;
  }
  // A local storage operation can throw from this DO's own SQLite/KV access,
  // rather than from a remote stub. Workerd supplies no lifecycle flags on
  // that path. Match only its exact code-update sentence or its opaque storage
  // reference so lookalike application messages stay outside this classifier.
  return (
    error instanceof Error &&
    (error.message === "Durable Object reset because its code was updated." ||
      /^Internal error in Durable Object storage caused object to be reset; reference = [a-z0-9]{8,128}$/u.test(
        error.message,
      ))
  );
}

/**
 * Whether an idempotent caller may replay a Durable Object operation after
 * either a direct workerd lifecycle rejection or a nested Stream rejection
 * that crossed RPC with the explicit stream-unavailable tag.
 *
 * Domain code commonly wraps infrastructure failures with useful context, so
 * inspect the local cause chain as well. Cycles are rejected rather than
 * turning classification into unbounded work.
 */
export function isRetryableDurableObjectAvailabilityError(error: unknown): boolean {
  const seen = new Set<object>();
  let candidate = error;
  while (typeof candidate === "object" && candidate !== null) {
    if (isDurableObjectLifecycleError(candidate) || isStreamUnavailableError(candidate)) {
      return true;
    }
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Replay one explicitly idempotent Durable Object operation on a fresh
 * incarnation. The operation gets exactly one retry; a second availability
 * failure is authoritative and application failures are never replayed.
 */
export async function retryIdempotentDurableObjectOperation<Result>(args: {
  operation: () => Promise<Result>;
  onRetry?: (context: { attempt: number; error: unknown; maxAttempts: 2 }) => void;
}): Promise<Result> {
  try {
    return await args.operation();
  } catch (error) {
    if (!isRetryableDurableObjectAvailabilityError(error)) throw error;
    args.onRetry?.({ attempt: 1, error, maxAttempts: 2 });
    return await args.operation();
  }
}

/**
 * Terminate a Durable Object RPC rejection at the public worker boundary.
 * Lifecycle failures receive {@link STREAM_UNAVAILABLE_MESSAGE_PREFIX};
 * application failures retain their message. Every outcome becomes a fresh,
 * plain `Error`: a native Workers RPC exception can carry remote internals
 * that cannot safely be forwarded through Cap'n Web as a second RPC error.
 *
 * `.catch` this onto stream stub calls that return plain data promises — never
 * onto ones returning stubs (a `.catch` collapses an RpcPromise into a settled
 * promise and loses the stub).
 */
export function rethrowStreamUnavailable(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (isDurableObjectLifecycleError(error)) {
    throw new Error(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}${message}`);
  }
  throw new Error(message);
}

/**
 * Whether a rejection — typically after crossing capnweb, where only the
 * message survives — carries the stream-unavailable tag. The client half of
 * the contract: for idempotent calls this means "retry; the stream reboots on
 * the next call".
 */
export function isStreamUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STREAM_UNAVAILABLE_MESSAGE_PREFIX);
}

/** Whether a rejection is the stream DO's explicitly modelled waiter timeout. */
export function isStreamWaitTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(STREAM_WAIT_TIMEOUT_MESSAGE_PREFIX);
}
