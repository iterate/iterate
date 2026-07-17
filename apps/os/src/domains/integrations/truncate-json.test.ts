import { describe, expect, it } from "vitest";
import { truncateJsonToBytes } from "./truncate-json.ts";

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("truncateJsonToBytes", () => {
  it("leaves JSON below the byte limit untouched", () => {
    const value = { kind: "answer", payload: { answer: 42 } };

    const result = truncateJsonToBytes(value, 1_024);

    expect(result).toEqual({
      bytes: jsonBytes(value),
      originalBytes: jsonBytes(value),
      truncated: false,
      value,
    });
    expect(result.value).toBe(value);
  });

  it("truncates the largest nested string while preserving its siblings", () => {
    const value = {
      kind: "answer",
      payload: {
        answer: 42,
        transcript: "x".repeat(20_000),
      },
      source: { durable: true },
    };

    const result = truncateJsonToBytes(value, 1_024);

    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(jsonBytes(value));
    expect(result.bytes).toBeLessThanOrEqual(1_024);
    expect(result.value).toMatchObject({
      kind: "answer",
      payload: { answer: 42 },
      source: { durable: true },
    });
    expect((result.value as typeof value).payload.transcript).toMatch(
      /\[truncated from \d+ JSON bytes\]$/,
    );
    expect(value.payload.transcript).toHaveLength(20_000);
  });

  it("measures encoded JSON bytes and never splits a Unicode code point", () => {
    const value = { payload: `quoted: \\"${"😀".repeat(4_000)}` };

    const result = truncateJsonToBytes(value, 257);
    const compacted = result.value as typeof value;

    expect(result.bytes).toBe(jsonBytes(result.value));
    expect(result.bytes).toBeLessThanOrEqual(257);
    expect(compacted.payload).not.toContain("�");
    expect(compacted.payload).toMatch(/\[truncated from \d+ JSON bytes\]$/);
  });

  it("chops a wide object when no individual value is large", () => {
    const value = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`field_${index}`, index]),
    );

    const result = truncateJsonToBytes(value, 512);
    const compacted = result.value as Record<string, unknown>;

    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(512);
    expect(compacted.field_0).toBe(0);
    expect(compacted.field_999).toBeUndefined();
    expect(compacted.$iterate_truncated).toMatch(/properties/);
  });
});
