import { expect, test } from "vitest";
import { appendText } from "./chunked-text.ts";
import { createJsonByteLength } from "./json-byte-length.ts";

test("matches actual UTF-8 JSON bytes across immutable streamed updates", () => {
  const measure = createJsonByteLength();
  let text = appendText("", "a".repeat(32768));
  for (const suffix of ["\u0000", "🦊", "\ud800", '"\\\n']) {
    text = appendText(text, suffix);
    const value = { text, absent: undefined, list: [null, true, undefined, 123, "é"] };
    expect(measure(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);
  }
});

test("does not inspect unchanged objects again", () => {
  let reads = 0;
  const stable = {
    get text() {
      reads += 1;
      return "sealed";
    },
  };
  const measure = createJsonByteLength();
  measure({ stable, n: 0 });
  measure({ stable, n: 1 });
  expect(reads).toBe(1);
});

test("rejects a cyclic non-JSON value", () => {
  const value: { self?: unknown } = {};
  value.self = value;
  expect(() => createJsonByteLength()(value)).toThrow(/cyclic/);
});
