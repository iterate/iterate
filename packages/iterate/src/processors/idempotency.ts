// The Stream DO's idempotency semantics, importable: a same-key append is a
// dedup ONLY when its body is structurally identical — otherwise it must be
// rejected. Lives here so the production Stream Durable Object and the
// MemoryStream test double share ONE predicate and cannot drift.

type EventBody = {
  type: string;
  payload?: unknown;
  metadata?: unknown;
  ephemeral?: boolean | undefined;
};

/** Whether a requested append names the SAME event an idempotency key already committed. */
export function sameIdempotentEvent(existing: EventBody, requested: EventBody): boolean {
  return (
    existing.type === requested.type &&
    jsonValuesEqual(existing.payload, requested.payload) &&
    jsonValuesEqual(existing.metadata, requested.metadata) &&
    existing.ephemeral === requested.ephemeral
  );
}

/** Structural JSON equality (key-order-insensitive). */
export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValuesEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    );
  }
  return false;
}
