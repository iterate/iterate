// resource-budget.ts — conservative admission for values that cross Workers RPC. workerd serializes
// with `jsg::Serializer` and only then asserts its 32 MiB limit (worker-rpc.c++); an append reply
// must therefore be bounded BEFORE its SQL transaction. This is intentionally an upper estimate of
// V8's wire shape, not JSON size: Maps, Sets, typed arrays and Errors have native data JSON drops.

import { codedError } from "../lib/errors.ts";
import type { StreamEvent, StreamEventInput } from "./events.ts";

const MiB = 1024 * 1024;
/** Workerd's hard `MAX_JS_RPC_MESSAGE_SIZE` is 32 MiB. Keep two MiB for serializer framing we cannot
 * observe from JavaScript and for a future workerd representation change. */
export const APPEND_REPLY_BUDGET_BYTES = 30 * MiB;
/** One value is admitted only when its decoded structural shape leaves room for its raw input and
 * the normal RPC copies inside a 128 MiB isolate. A 6 MiB string is ~12 MiB by this UTF-16 bound;
 * the known 4 MiB `[[]]` density is >100 MiB and is refused before the DO decodes it. */
export const APPEND_EVENT_SHAPE_BUDGET_BYTES = 64 * MiB;

const VALUE_TAG_AND_SLOT_BYTES = 16;
const OBJECT_BYTES = 32;
const MEMBER_BYTES = 24;
const REFERENCE_BYTES = 16;

/** The same shape will exceed on every retry until the caller splits/re-encodes it. Stamping this
 * tells delivery/retry machinery to stop rather than create an unbounded retry storm. */
const resourceRefusal = (
  code: "EVENT_TOO_COMPLEX" | "EVENT_VALUE_UNSUPPORTED" | "APPEND_REPLY_TOO_LARGE",
  message: string,
  data: Record<string, unknown>,
): Error => Object.assign(codedError(code, message, data), { retryable: false });

/** An upper model of the value kinds workerd's V8 serializer accepts. Strings are charged as UTF-16,
 * keys and members have explicit slots, and all collection entries recurse. Unknown native values
 * refuse loudly rather than being silently measured as JSON (where e.g. a Map becomes `{}`). */
type Estimate = { bytes: number; unsupported?: string };
export function estimateNativeValue(value: unknown, maximumBytes = Infinity): Estimate {
  const seen = new WeakSet<object>();
  let unsupported: string | undefined;
  const inspectOwnShape = (object: object) => {
    for (const key of Object.getOwnPropertyNames(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && !("value" in descriptor)) unsupported ??= "accessor property";
    }
    if (Object.getOwnPropertySymbols(object).length > 0) unsupported ??= "symbol-keyed property";
  };
  const visit = (current: unknown): number => {
    if (current === null || current === undefined) return VALUE_TAG_AND_SLOT_BYTES;
    switch (typeof current) {
      case "boolean":
      case "number":
      case "bigint":
        return VALUE_TAG_AND_SLOT_BYTES;
      case "string":
        return capped(VALUE_TAG_AND_SLOT_BYTES + current.length * 2, maximumBytes);
      case "symbol":
      case "function":
        unsupported ??= typeof current;
        return APPEND_REPLY_BUDGET_BYTES + 1;
      case "object":
        break;
      default:
        unsupported ??= typeof current;
        return APPEND_REPLY_BUDGET_BYTES + 1;
    }
    if (seen.has(current)) return REFERENCE_BYTES;
    seen.add(current);
    // Inspect binary/date-like kinds before enumerating own names: a typed array's index names can
    // themselves allocate megabytes, defeating an admission guard before it reaches byteLength.
    if (current instanceof Date) return OBJECT_BYTES + VALUE_TAG_AND_SLOT_BYTES;
    if (current instanceof RegExp)
      return capped(
        OBJECT_BYTES +
          VALUE_TAG_AND_SLOT_BYTES +
          (current.source.length + current.flags.length) * 2,
        maximumBytes,
      );
    if (current instanceof ArrayBuffer)
      return capped(OBJECT_BYTES + VALUE_TAG_AND_SLOT_BYTES + current.byteLength, maximumBytes);
    if (ArrayBuffer.isView(current))
      return capped(OBJECT_BYTES + VALUE_TAG_AND_SLOT_BYTES + current.byteLength, maximumBytes);
    if (current instanceof Map) {
      inspectOwnShape(current);
      let bytes = OBJECT_BYTES;
      for (const [key, entry] of current) {
        bytes += MEMBER_BYTES + visit(key) + visit(entry);
        if (bytes > maximumBytes) return maximumBytes + 1;
      }
      return bytes;
    }
    if (current instanceof Set) {
      inspectOwnShape(current);
      let bytes = OBJECT_BYTES;
      for (const entry of current) {
        bytes += MEMBER_BYTES + visit(entry);
        if (bytes > maximumBytes) return maximumBytes + 1;
      }
      return bytes;
    }
    if (current instanceof Error) {
      inspectOwnShape(current);
      let bytes = OBJECT_BYTES + visit(current.name) + visit(current.message);
      if (current.stack) bytes += visit(current.stack);
      return capped(bytes + ownMembers(current, visit, false, maximumBytes), maximumBytes);
    }
    if (Array.isArray(current)) {
      let bytes = OBJECT_BYTES;
      // Do not call Object.getOwnPropertyNames() here: on a dense array it allocates one string per
      // index before the budget can stop us. Indexed descriptors are walked incrementally instead.
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor && !("value" in descriptor)) {
          unsupported ??= "array accessor";
          return maximumBytes + 1;
        }
        bytes += MEMBER_BYTES + visit(descriptor?.value);
        if (bytes > maximumBytes) return maximumBytes + 1;
      }
      // `for…in` visits enumerable custom properties without materializing an index-name array.
      // V8 serializes these properties; non-enumerable array metadata is not part of the value.
      for (const key in current) {
        if (/^(0|[1-9]\d*)$/.test(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor)) {
          unsupported ??= "array accessor";
          return maximumBytes + 1;
        }
        bytes += MEMBER_BYTES + visit(key) + visit(descriptor.value);
        if (bytes > maximumBytes) return maximumBytes + 1;
      }
      if (Object.getOwnPropertySymbols(current).length > 0) unsupported ??= "symbol-keyed property";
      return bytes;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      unsupported ??= Object.prototype.toString.call(current);
      return APPEND_REPLY_BUDGET_BYTES + 1;
    }
    inspectOwnShape(current);
    return capped(OBJECT_BYTES + ownMembers(current, visit, false, maximumBytes), maximumBytes);
  };
  return { bytes: visit(value), ...(unsupported && { unsupported }) };
}

function ownMembers(
  object: object,
  visit: (value: unknown) => number,
  skipArrayIndexes = false,
  maximumBytes = Infinity,
): number {
  let bytes = 0;
  for (const key of Object.getOwnPropertyNames(object)) {
    if (key === "length" || (skipArrayIndexes && /^(0|[1-9]\d*)$/.test(key))) continue;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) return APPEND_REPLY_BUDGET_BYTES + 1;
    bytes += MEMBER_BYTES + visit(key) + visit(descriptor.value);
    if (bytes > maximumBytes) return maximumBytes + 1;
  }
  for (const symbol of Object.getOwnPropertySymbols(object)) {
    // Symbols can name state V8 serializes but JSON cannot represent. Refuse rather than omit it.
    void symbol;
    return APPEND_REPLY_BUDGET_BYTES + 1;
  }
  return bytes;
}

const capped = (bytes: number, maximumBytes: number): number =>
  bytes > maximumBytes ? maximumBytes + 1 : bytes;

export function assertAppendInputShape(events: StreamEventInput[]): void {
  for (const [index, event] of events.entries()) {
    const estimate = estimateNativeValue(event, APPEND_EVENT_SHAPE_BUDGET_BYTES);
    if (estimate.unsupported)
      throw resourceRefusal(
        "EVENT_VALUE_UNSUPPORTED",
        `append: event ${index} contains unsupported native value ${estimate.unsupported}; it cannot be safely admitted for durable storage or Workers RPC`,
        { index, kind: estimate.unsupported },
      );
    if (estimate.bytes > APPEND_EVENT_SHAPE_BUDGET_BYTES)
      throw resourceRefusal(
        "EVENT_TOO_COMPLEX",
        `append: event ${index}'s native decoded shape is estimated at ${estimate.bytes} bytes, over the ${APPEND_EVENT_SHAPE_BUDGET_BYTES / MiB} MiB isolate admission budget; nothing was appended`,
        { index, estimatedBytes: estimate.bytes, maxBytes: APPEND_EVENT_SHAPE_BUDGET_BYTES },
      );
  }
}

export function assertAppendReplyShape(receipts: StreamEvent[]): void {
  const estimate = estimateNativeValue(receipts, APPEND_REPLY_BUDGET_BYTES);
  if (estimate.unsupported)
    throw resourceRefusal(
      "EVENT_VALUE_UNSUPPORTED",
      `append: receipt contains unsupported native value ${estimate.unsupported}; nothing was appended`,
      { kind: estimate.unsupported },
    );
  if (estimate.bytes > APPEND_REPLY_BUDGET_BYTES)
    throw resourceRefusal(
      "APPEND_REPLY_TOO_LARGE",
      `append: ${receipts.length} receipts are estimated at ${estimate.bytes} bytes, over the ${APPEND_REPLY_BUDGET_BYTES / MiB} MiB native reply budget; nothing was appended`,
      {
        count: receipts.length,
        estimatedBytes: estimate.bytes,
        maxBytes: APPEND_REPLY_BUDGET_BYTES,
      },
    );
}

/** Edge's preflight has no assigned offsets or provenance receipts yet. Charge the largest number
 * spelling and stable identity fields; the DO repeats the exact receipt check after enrichment. */
export function assertAppendRequestAdmission(events: StreamEventInput[], path: string): void {
  assertAppendInputShape(events);
  assertAppendReplyShape(
    events.map(
      (event) =>
        ({
          ...event,
          offset: Number.MAX_SAFE_INTEGER,
          createdAt: "9999-12-31T23:59:59.999Z",
          path,
        }) as StreamEvent,
    ),
  );
}
