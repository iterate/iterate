import type { StreamEvent, StreamEventInput } from "./schemas.ts";
import { retryStreamUnavailable } from "./stream-unavailable.ts";

/**
 * Commit one atomic birth batch through Stream DO lifecycle resets.
 *
 * A create operation owns stable durable coordinates: every input is durable
 * and keyed, so an append whose commit succeeded but whose acknowledgement
 * was lost can be repeated without adding another fact. Retry only the
 * explicitly tagged Stream DO lifecycle outcome; application errors remain
 * fatal and the shared retry ceiling keeps reset storms bounded.
 */
export function appendIdempotentBirthBatch(input: {
  events: readonly StreamEventInput[];
  operation: string;
  stream: { append(...events: StreamEventInput[]): Promise<StreamEvent[]> };
}): Promise<StreamEvent[]> {
  if (input.events.length === 0) {
    throw new Error(`${input.operation} birth batch must contain at least one event`);
  }
  for (const event of input.events) {
    if (event.idempotencyKey === undefined) {
      throw new Error(`${input.operation} birth events must have idempotency keys`);
    }
    if (event.ephemeral === true) {
      throw new Error(`${input.operation} birth events must be durable`);
    }
  }

  const events = [...input.events];
  return retryStreamUnavailable(() => input.stream.append(...events), {
    onRetry: ({ error, failedAttempt }) => {
      console.warn("birth append interrupted by Stream DO lifecycle; retrying keyed batch", {
        error,
        failedAttempt,
        operation: input.operation,
      });
    },
  });
}
