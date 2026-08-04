const encoder = new TextEncoder();
const MINIMUM_TRUNCATED_VALUE = "[truncated]";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type MeasuredJson =
  | { bytes: number; kind: "primitive"; value: Exclude<JsonPrimitive, string> }
  | { bytes: number; kind: "string"; value: string }
  | { bytes: number; items: MeasuredJson[]; kind: "array"; value: JsonValue[] }
  | {
      bytes: number;
      entries: { key: string; keyBytes: number; value: MeasuredJson }[];
      kind: "object";
      value: { [key: string]: JsonValue };
    };

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Value must be JSON-serializable");
  }
  return serialized;
}

function serializedBytes(serialized: string): number {
  return encoder.encode(serialized).byteLength;
}

function primitiveJsonBytes(value: Exclude<JsonPrimitive, string>): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  // Oversized inputs are measured after a JSON stringify/parse round trip, so
  // numbers are finite and String(number) is JSON's canonical representation
  // (including -0 becoming "0").
  return String(value).length;
}

/**
 * Measure normalized JSON once, bottom-up. The previous implementation called
 * JSON.stringify for every ancestor and every candidate in a binary search;
 * a 10 MB string nested five levels deep was therefore copied and encoded
 * dozens of times inside the Stream Durable Object's append CPU budget.
 */
function measureJson(value: JsonValue): MeasuredJson {
  if (typeof value === "string") {
    return { bytes: jsonStringBytes(value), kind: "string", value };
  }
  if (value === null || typeof value !== "object") {
    return { bytes: primitiveJsonBytes(value), kind: "primitive", value };
  }
  if (Array.isArray(value)) {
    const items = value.map(measureJson);
    return {
      // Brackets + commas + each already-measured value.
      bytes: 2 + Math.max(0, items.length - 1) + items.reduce((sum, item) => sum + item.bytes, 0),
      items,
      kind: "array",
      value,
    };
  }

  const entries = Object.entries(value).map(([key, child]) => ({
    key,
    keyBytes: jsonStringBytes(key),
    value: measureJson(child),
  }));
  return {
    // Braces + commas + serialized key + colon + serialized value.
    bytes:
      2 +
      Math.max(0, entries.length - 1) +
      entries.reduce((sum, entry) => sum + entry.keyBytes + 1 + entry.value.bytes, 0),
    entries,
    kind: "object",
    value,
  };
}

/** JSON-string content bytes for one code point, and its UTF-16 width. */
function encodedStringUnit(value: string, index: number): { bytes: number; width: number } {
  const unit = value.charCodeAt(index);
  if (
    unit === 0x22 ||
    unit === 0x5c ||
    unit === 0x08 ||
    unit === 0x09 ||
    unit === 0x0a ||
    unit === 0x0c ||
    unit === 0x0d
  ) {
    return { bytes: 2, width: 1 };
  }
  if (unit <= 0x1f) return { bytes: 6, width: 1 };
  if (unit <= 0x7f) return { bytes: 1, width: 1 };
  if (unit <= 0x7ff) return { bytes: 2, width: 1 };
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, width: 2 };
    // Well-formed JSON.stringify escapes lone surrogates as \ud800-style text.
    return { bytes: 6, width: 1 };
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) return { bytes: 6, width: 1 };
  return { bytes: 3, width: 1 };
}

function jsonStringContentBytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const encoded = encodedStringUnit(value, index);
    bytes += encoded.bytes;
    index += encoded.width;
  }
  return bytes;
}

function jsonStringBytes(value: string): number {
  // JSON.stringify adds exactly two ASCII quote bytes around string content.
  return jsonStringContentBytes(value) + 2;
}

const minimumTruncatedBytes = jsonStringBytes(MINIMUM_TRUNCATED_VALUE);

function truncateString(value: string, maxBytes: number, originalBytes: number) {
  const marker = `… [truncated from ${originalBytes} JSON bytes]`;
  const prefixBudget = maxBytes - 2 - jsonStringContentBytes(marker);
  if (prefixBudget < 0) {
    return { bytes: minimumTruncatedBytes, value: MINIMUM_TRUNCATED_VALUE };
  }

  // Scan only the prefix that can survive (normally <= 100 KiB), regardless
  // of whether the discarded source string is 10 MB or 10 GB. This follows
  // JSON.stringify's escaping and never slices a surrogate pair.
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const encoded = encodedStringUnit(value, end);
    if (bytes + encoded.bytes > prefixBudget) break;
    bytes += encoded.bytes;
    end += encoded.width;
  }
  const compacted = `${value.slice(0, end)}${marker}`;
  return { bytes: bytes + jsonStringContentBytes(marker) + 2, value: compacted };
}

function largestChild(node: Extract<MeasuredJson, { kind: "array" | "object" }>): {
  index: number;
  value: MeasuredJson;
} | null {
  const children = node.kind === "array" ? node.items : node.entries.map((entry) => entry.value);
  let largest: { index: number; value: MeasuredJson } | null = null;
  for (const [index, value] of children.entries()) {
    if (largest === null || value.bytes > largest.value.bytes) largest = { index, value };
  }
  return largest;
}

function maximumCandidateLength(args: {
  length: number;
  maxBytes: number;
  candidateBytes(kept: number): number;
}): number | null {
  if (args.candidateBytes(0) > args.maxBytes) return null;
  let low = 0;
  // Truncation always drops at least one original item/property.
  let high = args.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (args.candidateBytes(middle) <= args.maxBytes) low = middle;
    else high = middle - 1;
  }
  return low;
}

function truncateArray(node: Extract<MeasuredJson, { kind: "array" }>, maxBytes: number) {
  const prefixBytes = [0];
  for (const item of node.items) prefixBytes.push(prefixBytes.at(-1)! + item.bytes);
  const marker = (kept: number) =>
    `[truncated ${node.items.length - kept} items; from ${node.bytes} JSON bytes]`;
  const candidateBytes = (kept: number) =>
    // Brackets + kept item bytes + marker bytes + one comma per kept item.
    2 + prefixBytes[kept]! + jsonStringBytes(marker(kept)) + kept;
  const kept = maximumCandidateLength({
    candidateBytes,
    length: node.items.length,
    maxBytes,
  });
  if (kept === null) {
    return { bytes: minimumTruncatedBytes, value: MINIMUM_TRUNCATED_VALUE };
  }
  return {
    bytes: candidateBytes(kept),
    value: [...node.items.slice(0, kept).map((item) => item.value), marker(kept)],
  };
}

function truncateObject(node: Extract<MeasuredJson, { kind: "object" }>, maxBytes: number) {
  let markerKey = "$iterate_truncated";
  while (Object.hasOwn(node.value, markerKey)) markerKey = `$${markerKey}`;

  const prefixBytes = [0];
  for (const entry of node.entries) {
    prefixBytes.push(prefixBytes.at(-1)! + entry.keyBytes + 1 + entry.value.bytes);
  }
  const marker = (kept: number) =>
    `[truncated ${node.entries.length - kept} properties; from ${node.bytes} JSON bytes]`;
  const markerKeyBytes = jsonStringBytes(markerKey);
  const candidateBytes = (kept: number) =>
    // Braces + kept entries + marker key/colon/value + one comma per kept entry.
    2 + prefixBytes[kept]! + markerKeyBytes + 1 + jsonStringBytes(marker(kept)) + kept;
  const kept = maximumCandidateLength({
    candidateBytes,
    length: node.entries.length,
    maxBytes,
  });
  if (kept === null) {
    return { bytes: minimumTruncatedBytes, value: MINIMUM_TRUNCATED_VALUE };
  }
  return {
    bytes: candidateBytes(kept),
    value: Object.fromEntries([
      ...node.entries.slice(0, kept).map((entry) => [entry.key, entry.value.value] as const),
      [markerKey, marker(kept)],
    ]),
  };
}

function truncateMeasuredJson(
  node: MeasuredJson,
  maxBytes: number,
): { bytes: number; value: JsonValue } {
  if (node.bytes <= maxBytes) return { bytes: node.bytes, value: node.value };
  if (node.kind === "string") return truncateString(node.value, maxBytes, node.bytes);
  if (node.kind === "primitive") {
    return { bytes: minimumTruncatedBytes, value: MINIMUM_TRUNCATED_VALUE };
  }

  const largest = largestChild(node);
  const overflow = node.bytes - maxBytes;
  if (largest !== null && largest.value.bytes - minimumTruncatedBytes >= overflow) {
    const replacement = truncateMeasuredJson(largest.value, largest.value.bytes - overflow);
    if (node.kind === "array") {
      const value = node.items.map((item, index) =>
        index === largest.index ? replacement.value : item.value,
      );
      return { bytes: node.bytes - largest.value.bytes + replacement.bytes, value };
    }
    const value = Object.fromEntries(
      node.entries.map((entry, index) => [
        entry.key,
        index === largest.index ? replacement.value : entry.value.value,
      ]),
    );
    return { bytes: node.bytes - largest.value.bytes + replacement.bytes, value };
  }

  return node.kind === "array" ? truncateArray(node, maxBytes) : truncateObject(node, maxBytes);
}

type TruncatedJson = {
  bytes: number;
  originalBytes: number;
  truncated: boolean;
  value: unknown;
};

type PreviewOptions = {
  /** Arrays keep only their first N items (a truncation marker replaces the rest). */
  maxArrayItems: number;
  /** Strings longer than this keep a prefix plus a truncation marker. */
  maxStringChars: number;
  /** Containers nested at or below this depth collapse to a one-line summary string. */
  maxDepth: number;
  /** Hard ceiling on the serialized preview, enforced by truncateJsonToBytes. */
  maxBytes: number;
};

/** Small subtrees survive the depth/policy cuts untouched — replacing a tiny
 * leaf tuple with a "[truncated …]" marker would cost bytes to lose data. */
const PREVIEW_KEEP_INTACT_BYTES = 100;

/**
 * util.inspect-flavored preview: unlike truncateJsonToBytes (which keeps as
 * much as fits), this aggressively elides *everywhere* — a few items per
 * array, capped strings, bounded depth — so a bounded preview shows the
 * overall shape of a huge value instead of the start of its largest child.
 * The result still serializes within `maxBytes`.
 */
export function previewJson(value: unknown, options: PreviewOptions): TruncatedJson {
  const measured = measureJson(JSON.parse(serialize(value)) as JsonValue);
  const policied = applyPreviewPolicy(measured, options, 0);
  const bounded = truncateJsonToBytes(policied.value, options.maxBytes);
  return {
    bytes: bounded.bytes,
    originalBytes: measured.bytes,
    truncated: policied.changed || bounded.truncated,
    value: bounded.value,
  };
}

function applyPreviewPolicy(
  node: MeasuredJson,
  options: PreviewOptions,
  depth: number,
): { changed: boolean; value: JsonValue } {
  if (node.bytes <= PREVIEW_KEEP_INTACT_BYTES) return { changed: false, value: node.value };
  if (node.kind === "primitive") return { changed: false, value: node.value };
  if (node.kind === "string") {
    if (node.value.length <= options.maxStringChars) return { changed: false, value: node.value };
    // Back off one unit if the cut lands mid-surrogate-pair — a lone high
    // surrogate would render as a \udxxx escape in the pretty-printed preview.
    let end = options.maxStringChars;
    const lastUnit = node.value.charCodeAt(end - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
    return {
      changed: true,
      value: `${node.value.slice(0, end)}… [truncated from ${node.bytes} JSON bytes]`,
    };
  }
  if (node.kind === "array") {
    if (depth >= options.maxDepth) {
      return {
        changed: true,
        value: `[array of ${node.items.length} items; ${node.bytes} JSON bytes]`,
      };
    }
    const kept = node.items
      .slice(0, options.maxArrayItems)
      .map((item) => applyPreviewPolicy(item, options, depth + 1));
    const dropped = node.items.length - kept.length;
    return {
      changed: dropped > 0 || kept.some((item) => item.changed),
      value: [
        ...kept.map((item) => item.value),
        ...(dropped > 0 ? [`[truncated ${dropped} items; from ${node.bytes} JSON bytes]`] : []),
      ],
    };
  }
  if (depth >= options.maxDepth) {
    return {
      changed: true,
      value: `[object with ${node.entries.length} properties; ${node.bytes} JSON bytes]`,
    };
  }
  const entries = node.entries.map((entry) => ({
    key: entry.key,
    result: applyPreviewPolicy(entry.value, options, depth + 1),
  }));
  return {
    changed: entries.some((entry) => entry.result.changed),
    value: Object.fromEntries(entries.map((entry) => [entry.key, entry.result.value])),
  };
}

/**
 * Keep JSON intact until it crosses a byte boundary, then deterministically
 * chop the tail of its largest useful nested value. The input is never mutated
 * and the returned value always serializes within `maxBytes`.
 */
export function truncateJsonToBytes(value: unknown, maxBytes: number): TruncatedJson {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < minimumTruncatedBytes) {
    throw new RangeError(`maxBytes must be an integer of at least ${minimumTruncatedBytes}`);
  }

  // Serialize once to apply JSON's toJSON/undefined/NaN semantics. UTF-16
  // length is a lower bound for UTF-8 JSON length, so only encode the fast
  // path when it is already bounded by maxBytes. A 10 MB value must not create
  // a second 10 MB TextEncoder buffer merely to discover that it is oversized.
  const serialized = serialize(value);
  if (serialized.length <= maxBytes) {
    const originalBytes = serializedBytes(serialized);
    if (originalBytes <= maxBytes) {
      return { bytes: originalBytes, originalBytes, truncated: false, value };
    }
  }

  const measured = measureJson(JSON.parse(serialized) as JsonValue);
  const compacted = truncateMeasuredJson(measured, maxBytes);
  // Verification is intentionally bounded: the compacted representation is
  // at most maxBytes even when the source was gigabytes. Keep exact accounting
  // as an asserted invariant without recreating the discarded source tail.
  const compactedBytes = serializedBytes(serialize(compacted.value));
  if (compactedBytes !== compacted.bytes || compactedBytes > maxBytes) {
    throw new Error("truncated JSON byte accounting invariant failed");
  }
  return {
    bytes: compactedBytes,
    originalBytes: measured.bytes,
    truncated: true,
    value: compacted.value,
  };
}
