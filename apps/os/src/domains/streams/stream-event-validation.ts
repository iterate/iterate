import { z } from "zod";
import { StreamEventInput, type StreamEvent } from "./schemas.ts";

// `z.record(z.string(), z.unknown())` walks every payload/metadata key through
// two no-op schemas, then shallow-copies it. On large event payloads that work
// can dominate append turns. This equivalent keeps Zod's plain-record
// acceptance and shallow-copy semantics while native object spread performs
// the copy; the canonical public append schema remains unchanged.
const UnknownRecord = z.custom<Record<string, unknown>>(isUnknownRecord).transform((value) => {
  return copyUnknownRecord(value);
});

/**
 * What `append` accepts over the wire: a public event input plus the optional
 * `offset` optimistic-concurrency assertion (split off before validation).
 * Built once: constructing a Zod schema per event cost roughly 20 us/event.
 */
export const StreamAppendInput = StreamEventInput.extend({
  payload: UnknownRecord.optional(),
  metadata: UnknownRecord.optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict();

type ParsedStreamAppendInput = z.output<typeof StreamAppendInput>;

/**
 * Common source-free append envelope without Zod's per-field parser dispatch.
 * Anything outside that shape falls back to the canonical schema, keeping its
 * validation errors and normalization semantics as the correctness boundary.
 */
export function parseStreamAppendInput(value: unknown): ParsedStreamAppendInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return StreamAppendInput.parse(value);
  }
  const input = value as Record<string, unknown>;
  if (input.source !== undefined || !appendInputKeysAreKnown(input)) {
    return StreamAppendInput.parse(value);
  }
  if (typeof input.type !== "string") return StreamAppendInput.parse(value);
  if (input.ephemeral !== undefined && input.ephemeral !== true) {
    return StreamAppendInput.parse(value);
  }
  if (
    input.offset !== undefined &&
    (typeof input.offset !== "number" || !Number.isInteger(input.offset) || input.offset < 0)
  ) {
    return StreamAppendInput.parse(value);
  }

  const payload =
    input.payload === undefined
      ? undefined
      : isUnknownRecord(input.payload)
        ? copyUnknownRecord(input.payload)
        : null;
  if (payload === null) return StreamAppendInput.parse(value);
  const metadata =
    input.metadata === undefined
      ? undefined
      : isUnknownRecord(input.metadata)
        ? copyUnknownRecord(input.metadata)
        : null;
  if (metadata === null) return StreamAppendInput.parse(value);

  const rawIdempotencyKey = input.idempotencyKey;
  let idempotencyKey: string | undefined;
  if (rawIdempotencyKey !== undefined) {
    if (typeof rawIdempotencyKey !== "string") return StreamAppendInput.parse(value);
    idempotencyKey = rawIdempotencyKey.trim();
    if (idempotencyKey.length === 0) return StreamAppendInput.parse(value);
  }

  const parsed: ParsedStreamAppendInput = { type: input.type };
  if (Object.hasOwn(input, "payload")) parsed.payload = payload;
  if (Object.hasOwn(input, "metadata")) parsed.metadata = metadata;
  if (Object.hasOwn(input, "source")) parsed.source = undefined;
  if (Object.hasOwn(input, "idempotencyKey")) parsed.idempotencyKey = idempotencyKey;
  if (Object.hasOwn(input, "ephemeral")) parsed.ephemeral = input.ephemeral as true | undefined;
  if (Object.hasOwn(input, "offset")) parsed.offset = input.offset as number | undefined;
  return parsed;
}

/**
 * Idempotency names one logical event, not any write that happens to reuse a
 * key. Provenance is excluded so a processor retry remains valid after its
 * source-version stamp changes across a deployment.
 */
export function sameIdempotentEvent(existing: StreamEvent, requested: StreamEventInput): boolean {
  return (
    existing.type === requested.type &&
    jsonValuesEqual(existing.payload, requested.payload) &&
    jsonValuesEqual(existing.metadata, requested.metadata) &&
    existing.ephemeral === requested.ephemeral
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  // Match Zod's plain-object test, including null-prototype and cross-realm
  // objects while excluding class instances and built-ins such as Date/Map.
  const constructor = (value as { constructor?: unknown }).constructor;
  if (typeof constructor === "function") {
    const prototype = constructor.prototype as unknown;
    if (typeof prototype !== "object" || prototype === null || Array.isArray(prototype)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf")) return false;
  }

  // z.string() rejects enumerable symbol record keys. Non-enumerable symbols
  // are ignored by both Zod records and object rest.
  return !Object.getOwnPropertySymbols(value).some((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key),
  );
}

function copyUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
  const record = { ...value };
  delete record["__proto__"];
  return record;
}

function appendInputKeysAreKnown(input: Record<string, unknown>): boolean {
  for (const key of Object.keys(input)) {
    switch (key) {
      case "type":
      case "payload":
      case "metadata":
      case "source":
      case "idempotencyKey":
      case "ephemeral":
      case "offset":
        break;
      default:
        return false;
    }
  }
  return true;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return (
    leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
