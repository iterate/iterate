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

  it("accounts for large siblings when assigning a child byte budget", () => {
    const value = {
      before: "a".repeat(600),
      largest: "x".repeat(1_000),
      after: "b".repeat(500),
    };

    const result = truncateJsonToBytes(value, 1_400);

    expect(result.bytes).toBe(jsonBytes(result.value));
    expect(result.bytes).toBeLessThanOrEqual(1_400);
    expect(result.value).toMatchObject({ before: value.before, after: value.after });
    expect((result.value as typeof value).largest).toMatch(/\[truncated from \d+ JSON bytes\]$/);
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

  it("keeps exact JSON escaping at the truncation boundary", () => {
    const value = {
      payload: `line\nquote"slash\\${"😀".repeat(100)}\ud800${"x".repeat(10_000)}`,
    };

    const result = truncateJsonToBytes(value, 257);

    expect(result.bytes).toBe(jsonBytes(result.value));
    expect(result.bytes).toBeLessThanOrEqual(257);
    expect((result.value as typeof value).payload).not.toContain("�");
  });

  it("matches native byte accounting across normalized JSON shapes and budgets", () => {
    const values: unknown[] = [
      `ascii\nquote"slash\\${"é".repeat(20)}${"😀".repeat(20)}\ud800`,
      [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, true, "x".repeat(500)],
      {
        control: "\u0000\b\t\n\f\r",
        nested: [{ alpha: "a".repeat(300) }, { omega: "ω".repeat(300) }],
      },
      {
        $iterate_truncated: "occupied",
        ...Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`field_${index}`, `value_${index}`]),
        ),
      },
      { toJSON: () => ({ normalized: true, payload: "z".repeat(500) }) },
    ];
    const budgets = [13, 14, 31, 64, 127, 256, 512, 1_024];

    for (const value of values) {
      for (const maxBytes of budgets) {
        const result = truncateJsonToBytes(value, maxBytes);
        expect(result.originalBytes).toBe(jsonBytes(value));
        expect(result.bytes).toBe(jsonBytes(result.value));
        expect(result.bytes).toBeLessThanOrEqual(maxBytes);
      }
    }
  });

  it("bounds a deeply nested 10 MB result without repeatedly copying the discarded tail", () => {
    const value = {
      type: "events.iterate.com/capability-host/script-run-settled",
      payload: {
        settlement: {
          status: "succeeded",
          result: { blob: "x".repeat(10_000_000), marker: "tail" },
        },
      },
    };

    const result = truncateJsonToBytes(value, 100 * 1_024);

    expect(result.originalBytes).toBe(jsonBytes(value));
    expect(result.bytes).toBe(jsonBytes(result.value));
    expect(result.bytes).toBe(100 * 1_024);
    expect(result.value).toMatchObject({
      type: value.type,
      payload: { settlement: { status: "succeeded", result: { marker: "tail" } } },
    });
    expect((result.value as typeof value).payload.settlement.result.blob).toMatch(
      /\[truncated from \d+ JSON bytes\]$/,
    );
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
