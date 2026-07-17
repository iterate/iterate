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
  // Storage/RPC clients preserve the workerd rejection as `cause` while
  // wrapping it with their own query context. Walk that standard error chain
  // so the lifecycle contract survives useful infrastructure wrappers. The
  // depth cap and identity set make hostile/cyclic cause graphs harmless.
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    const flags = current as {
      cause?: unknown;
      durableObjectReset?: unknown;
      retryable?: unknown;
      overloaded?: unknown;
    };
    if (
      flags.durableObjectReset === true ||
      flags.retryable === true ||
      flags.overloaded === true
    ) {
      return true;
    }
    current = flags.cause;
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
export function isStreamUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes(STREAM_UNAVAILABLE_MESSAGE_PREFIX);
}

/**
 * Retry one operation whose durable coordinate is stable across Stream DO
 * incarnations. The caller supplies a fresh stub call each attempt. Only our
 * explicit lifecycle tag is retryable; application errors escape unchanged,
 * and the four-attempt ceiling prevents a reset storm from becoming an
 * unbounded request.
 */
export async function retryStreamUnavailable<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    onRetry?: (args: { failedAttempt: number; error: Error }) => void;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive safe integer");
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isStreamUnavailableError(error) || attempt >= maxAttempts) throw error;
      options.onRetry?.({ failedAttempt: attempt, error });
    }
  }
}
