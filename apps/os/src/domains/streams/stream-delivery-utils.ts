import type { StreamEvent, StreamEventInput } from "iterate/processors";
import { StreamReceiverUnavailableError } from "iterate/processors";

export const DEFAULT_DELIVERY_TIMEOUT_MS = 20_000;

/**
 * Namespace reserved for idempotency keys minted while one stream appends an
 * event received from another. Public appends must never be able to occupy a
 * future source coordinate before the platform delivery arrives.
 */
const INTERNAL_STREAM_IDEMPOTENCY_PREFIX = "iterate-internal";

/** Collision-free, human-readable identity for arbitrary string/number tuples. */
export function structuredId(
  prefix: string,
  ...parts: readonly (string | number | null)[]
): string {
  return `${prefix}:${JSON.stringify(parts)}`;
}

/**
 * Mint a stream event idempotency key in the platform-only namespace. Public
 * appends reject this entire namespace before looking for an existing key, so
 * an ordinary event can neither reserve a future platform key nor masquerade
 * as an idempotent retry of an event the platform already appended.
 */
export function internalStreamId(
  family: string,
  ...parts: readonly (string | number | null)[]
): string {
  return structuredId(internalStreamIdPrefix(family), ...parts);
}

export function internalStreamIdPrefix(family: string): string {
  return `${INTERNAL_STREAM_IDEMPOTENCY_PREFIX}/${family}`;
}

export function isInternalStreamIdempotencyKey(value: string | undefined): boolean {
  return value?.startsWith(`${INTERNAL_STREAM_IDEMPOTENCY_PREFIX}/`) ?? false;
}

/** Match a leading tuple without falling back to delimiter-sensitive string prefixes. */
export function hasStructuredIdPrefix(
  value: string | undefined,
  prefix: string,
  ...parts: readonly (string | number | null)[]
): boolean {
  if (value === undefined || !value.startsWith(`${prefix}:`)) return false;
  try {
    const tuple: unknown = JSON.parse(value.slice(prefix.length + 1));
    return Array.isArray(tuple) && parts.every((part, index) => Object.is(tuple[index], part));
  } catch {
    return false;
  }
}

/**
 * Bound one receiver call so an unresponsive receiver cannot block event sending
 * forever. The receiver remains responsible for the underlying late work;
 * callers may dispose a capability that arrives after the timeout won.
 */
export async function withDeliveryTimeout<T>(
  promise: Promise<T>,
  label: string,
  opts: {
    onLateResolve?: (value: T) => void;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (opts.onLateResolve !== undefined) {
    const onLateResolve = opts.onLateResolve;
    void promise.then(
      (value) => {
        if (timedOut) onLateResolve(value);
      },
      () => {
        // The raced timeout already surfaced the failure; a late rejection
        // owns no capability that needs disposal.
      },
    );
  }
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new StreamReceiverUnavailableError(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "unknown error";
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return error.message;
  }
  return String(error) || "unknown error";
}

/** Safe text for an error persisted in a stream event's bounded payload. */
export function boundedErrorMessage(error: unknown): string | undefined {
  const message = errorMessage(error).trim().slice(0, 4_096);
  return message.length === 0 ? undefined : message;
}

/**
 * Whether two copy appends materialize the same source coordinate.
 * The source hop, not the event body, is the exactly-once identity.
 */
export function sameCopiedEventIdentity(
  existing: StreamEvent,
  incoming: StreamEventInput,
): boolean {
  const existingHop = existing.source?.copiedFrom?.at(-1);
  const incomingHop = incoming.source?.copiedFrom?.at(-1);
  return (
    existingHop !== undefined &&
    incomingHop !== undefined &&
    existingHop.subscriptionKey === incomingHop.subscriptionKey &&
    existingHop.cursorChangedAtSourceOffset === incomingHop.cursorChangedAtSourceOffset &&
    existingHop.projectId === incomingHop.projectId &&
    existingHop.path === incomingHop.path &&
    existingHop.streamId === incomingHop.streamId &&
    existingHop.streamCreatedAt === incomingHop.streamCreatedAt &&
    existingHop.offset === incomingHop.offset
  );
}
