const encoder = new TextEncoder();
const MINIMUM_TRUNCATED_VALUE = "[truncated]";

export type TruncatedJson = {
  bytes: number;
  originalBytes: number;
  truncated: boolean;
  value: unknown;
};

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Value must be JSON-serializable");
  }
  return serialized;
}

function jsonBytes(value: unknown): number {
  return encoder.encode(serialize(value)).byteLength;
}

const minimumTruncatedBytes = jsonBytes(MINIMUM_TRUNCATED_VALUE);

function truncateString(value: string, maxBytes: number, originalBytes: number): string {
  const marker = `… [truncated from ${originalBytes} JSON bytes]`;
  if (jsonBytes(marker) > maxBytes) return MINIMUM_TRUNCATED_VALUE;

  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${marker}`;
    if (jsonBytes(candidate) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}${marker}`;
}

function truncateArray(value: unknown[], maxBytes: number, originalBytes: number): unknown {
  const makeCandidate = (kept: number) => [
    ...value.slice(0, kept),
    `[truncated ${value.length - kept} items; from ${originalBytes} JSON bytes]`,
  ];
  if (jsonBytes(makeCandidate(0)) > maxBytes) return MINIMUM_TRUNCATED_VALUE;

  let low = 0;
  let high = value.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(makeCandidate(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return makeCandidate(low);
}

function truncateObject(
  value: Record<string, unknown>,
  maxBytes: number,
  originalBytes: number,
): unknown {
  const entries = Object.entries(value);
  let markerKey = "$iterate_truncated";
  while (Object.hasOwn(value, markerKey)) markerKey = `$${markerKey}`;

  const makeCandidate = (kept: number) =>
    Object.fromEntries([
      ...entries.slice(0, kept),
      [
        markerKey,
        `[truncated ${entries.length - kept} properties; from ${originalBytes} JSON bytes]`,
      ],
    ]);
  if (jsonBytes(makeCandidate(0)) > maxBytes) return MINIMUM_TRUNCATED_VALUE;

  let low = 0;
  let high = entries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(makeCandidate(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return makeCandidate(low);
}

function truncateLargestValue(value: unknown, maxBytes: number): unknown {
  const originalBytes = jsonBytes(value);
  if (originalBytes <= maxBytes) return value;
  if (typeof value === "string") return truncateString(value, maxBytes, originalBytes);
  if (value === null || typeof value !== "object") return MINIMUM_TRUNCATED_VALUE;

  const entries = Array.isArray(value) ? [...value.entries()] : Object.entries(value);
  let largest: { bytes: number; child: unknown; key: number | string } | undefined;
  for (const [key, child] of entries) {
    const bytes = jsonBytes(child);
    if (largest === undefined || bytes > largest.bytes) largest = { bytes, child, key };
  }
  const overflow = originalBytes - maxBytes;

  // Recurse when one child can absorb the whole overflow. Otherwise chopping
  // the enclosing collection's tail is both deterministic and bounded work.
  if (largest !== undefined && largest.bytes - minimumTruncatedBytes >= overflow) {
    const replacement = truncateLargestValue(largest.child, largest.bytes - overflow);
    if (Array.isArray(value)) {
      const copy = [...value];
      copy[largest.key as number] = replacement;
      return copy;
    }
    return Object.fromEntries(
      entries.map(([key, child]) => [key, key === largest.key ? replacement : child]),
    );
  }

  return Array.isArray(value)
    ? truncateArray(value, maxBytes, originalBytes)
    : truncateObject(value as Record<string, unknown>, maxBytes, originalBytes);
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

  const serialized = serialize(value);
  const originalBytes = encoder.encode(serialized).byteLength;
  if (originalBytes <= maxBytes) {
    return { bytes: originalBytes, originalBytes, truncated: false, value };
  }

  const compacted = truncateLargestValue(JSON.parse(serialized), maxBytes);
  return {
    bytes: jsonBytes(compacted),
    originalBytes,
    truncated: true,
    value: compacted,
  };
}
