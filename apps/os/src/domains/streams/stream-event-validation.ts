import { z } from "zod";
import { StreamEvent, StreamEventInput } from "./schemas.ts";

// `z.record(z.string(), z.unknown())` walks every payload/metadata key through
// two no-op schemas, then shallow-copies it. On large event payloads that work
// can dominate append and replay turns. This equivalent keeps Zod's plain-
// record acceptance and shallow-copy semantics while native object spread
// performs the copy; the canonical public schemas remain unchanged.
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

export type ParsedStreamAppendInput = z.output<typeof StreamAppendInput>;

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

/** Durable-row parser with the canonical committed-event envelope semantics. */
export const StreamStoredEvent = StreamEvent.extend({
  payload: UnknownRecord.optional(),
  metadata: UnknownRecord.optional(),
});

/**
 * Common source-free stored envelope directly after `JSON.parse`, without
 * Zod's per-field parser dispatch. JSON has already guaranteed that every
 * object is a plain string-keyed record, so repeating prototype and symbol
 * checks for the envelope, payload, and metadata only burns replay CPU.
 * Invalid or noncanonical row structures fall back to the canonical schema so
 * corruption still produces the same precise validation error.
 */
export function parseStreamStoredJsonEvent(value: unknown): StreamEvent {
  if (!isJsonRecord(value) || !storedEventKeysAreKnown(value)) {
    return StreamStoredEvent.parse(value);
  }
  if (typeof value.type !== "string") return StreamStoredEvent.parse(value);
  if (
    typeof value.offset !== "number" ||
    !Number.isInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.path !== "string"
  ) {
    return StreamStoredEvent.parse(value);
  }
  const path = value.path.trim();
  if (path.length === 0) return StreamStoredEvent.parse(value);
  if (value.ephemeral !== undefined && value.ephemeral !== true) {
    return StreamStoredEvent.parse(value);
  }

  const payload =
    value.payload === undefined
      ? undefined
      : isJsonRecord(value.payload)
        ? copyUnknownRecord(value.payload)
        : null;
  if (payload === null) return StreamStoredEvent.parse(value);
  const metadata =
    value.metadata === undefined
      ? undefined
      : isJsonRecord(value.metadata)
        ? copyUnknownRecord(value.metadata)
        : null;
  if (metadata === null) return StreamStoredEvent.parse(value);

  let idempotencyKey: string | undefined;
  if (value.idempotencyKey !== undefined) {
    if (typeof value.idempotencyKey !== "string") return StreamStoredEvent.parse(value);
    idempotencyKey = value.idempotencyKey.trim();
    if (idempotencyKey.length === 0) return StreamStoredEvent.parse(value);
  }

  // Assign in canonical schema order. Property order is observable when a
  // replayed event is later serialized for delivery or cross-posting.
  const parsed = { type: value.type } as StreamEvent;
  if (Object.hasOwn(value, "payload")) parsed.payload = payload;
  if (Object.hasOwn(value, "metadata")) parsed.metadata = metadata;
  if (Object.hasOwn(value, "idempotencyKey")) parsed.idempotencyKey = idempotencyKey;
  if (Object.hasOwn(value, "ephemeral")) parsed.ephemeral = value.ephemeral as true | undefined;
  parsed.offset = value.offset;
  parsed.createdAt = value.createdAt;
  parsed.path = path;
  return parsed;
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function storedEventKeysAreKnown(input: Record<string, unknown>): boolean {
  for (const key of Object.keys(input)) {
    switch (key) {
      case "type":
      case "payload":
      case "metadata":
      case "idempotencyKey":
      case "ephemeral":
      case "offset":
      case "createdAt":
      case "path":
        break;
      default:
        return false;
    }
  }
  return true;
}
