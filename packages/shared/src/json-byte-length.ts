/** Measure immutable JSON without re-encoding unchanged subtrees on every update.
 * Each counter belongs to one projection owner. Weak keys retain no old states. */
export function createJsonByteLength() {
  const sizes = new WeakMap<object, number>();
  const encoder = new TextEncoder();
  const visiting = new WeakSet<object>();
  function measure(value: unknown): number {
    if (value === null || typeof value !== "object") {
      return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
    }
    const cached = sizes.get(value);
    if (cached !== undefined) return cached;
    if (visiting.has(value)) throw new TypeError("Cannot measure cyclic JSON");
    visiting.add(value);
    let bytes = 2;
    let count = 0;
    if (Array.isArray(value)) {
      for (const item of value) {
        bytes += measure(item);
        count += 1;
      }
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        bytes += encoder.encode(JSON.stringify(key)).byteLength + 1 + measure(item);
        count += 1;
      }
    }
    bytes += Math.max(0, count - 1);
    visiting.delete(value);
    sizes.set(value, bytes);
    return bytes;
  }
  return measure;
}
