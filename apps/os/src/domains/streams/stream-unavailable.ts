// The stream capability's availability-error contract, shared by the worker
// door that MINTS the tag (StreamRpcTarget in rpc-targets.ts) and the clients
// that CLASSIFY it (the browser mirror's appendBatch retry loop). Kept
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
 * Whether a Durable Object stub rejection is a DO-lifecycle failure (the
 * incarnation died mid-call / is overloaded) as opposed to an app-level throw
 * from the DO's own code. These property flags are workerd's error contract;
 * an in-flight call rejected by `ctx.abort()` carries
 * `durableObjectReset: true` (empirically verified — see the PR that
 * introduced this module), evictions and deploy resets ride the same flag,
 * and overload/network families carry `overloaded`/`retryable`.
 */
export function isDurableObjectLifecycleError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  // Storage and RPC clients may preserve the workerd rejection as `cause`
  // while adding operation context. Bound and cycle-check that standard chain.
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    const flags = current as {
      cause?: unknown;
      durableObjectReset?: unknown;
      retryable?: unknown;
      overloaded?: unknown;
    };
    try {
      if (
        flags.durableObjectReset === true ||
        flags.retryable === true ||
        flags.overloaded === true
      ) {
        return true;
      }
      current = flags.cause;
    } catch {
      // This classifier runs from error-handling paths. Exotic rejection
      // values (for example a Proxy or a throwing getter) must remain an
      // unclassified original error rather than creating a second failure.
      return false;
    }
  }
  return false;
}

/**
 * Rethrow `error` tagged with {@link STREAM_UNAVAILABLE_MESSAGE_PREFIX} when
 * it is a DO-lifecycle failure, unchanged otherwise. `.catch` this onto stream
 * stub calls that return plain data promises — never onto ones returning
 * stubs (a `.catch` collapses an RpcPromise into a settled promise and loses
 * the stub).
 */
export function rethrowStreamUnavailable(error: unknown): never {
  if (isDurableObjectLifecycleError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${STREAM_UNAVAILABLE_MESSAGE_PREFIX}${message}`, { cause: error });
  }
  throw error;
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
