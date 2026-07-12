import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StreamEventInput } from "./schemas.ts";
import { parseStreamAppendInput, StreamAppendInput } from "./stream-event-validation.ts";

const BaselineStreamAppendInput = StreamEventInput.extend({
  offset: z.number().int().nonnegative().optional(),
}).strict();

describe("StreamAppendInput", () => {
  it("fast-parses common envelopes with canonical output and key presence", () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      retained: true,
    });
    const payload = JSON.parse('{"__proto__":{"polluted":true},"nested":{}}') as Record<
      string,
      unknown
    >;
    const inputs: unknown[] = [
      { type: "test/event" },
      {
        type: "test/event",
        payload: undefined,
        metadata: undefined,
        source: undefined,
        idempotencyKey: undefined,
        ephemeral: undefined,
        offset: undefined,
      },
      {
        type: "test/event",
        payload,
        metadata: nullPrototype,
        idempotencyKey: " key ",
        ephemeral: true,
        offset: -0,
      },
      {
        type: "test/event",
        source: {
          processor: {
            slug: "processor",
            version: "1",
            stream: { path: "/tests", projectId: null },
          },
        },
      },
    ];

    for (const input of inputs) {
      const expected = BaselineStreamAppendInput.parse(input);
      const parsed = parseStreamAppendInput(input);
      expect(parsed).toEqual(expected);
      expect(Object.keys(parsed)).toEqual(Object.keys(expected));
    }

    const parsed = parseStreamAppendInput(inputs[2]);
    expect(parsed.payload).not.toBe(payload);
    expect(Object.prototype.hasOwnProperty.call(parsed.payload, "__proto__")).toBe(false);
  });

  it("falls back to canonical validation errors for invalid or uncommon envelopes", () => {
    const inputs: unknown[] = [
      null,
      [],
      { type: 1 },
      { type: "test/event", extra: true },
      { type: "test/event", payload: [] },
      { type: "test/event", metadata: new Date(0) },
      { type: "test/event", idempotencyKey: " " },
      { type: "test/event", ephemeral: false },
      { type: "test/event", offset: 1.5 },
      { type: "test/event", source: { processor: { slug: 1 } } },
    ];

    for (const input of inputs) {
      const expected = StreamAppendInput.safeParse(input);
      if (expected.success) throw new Error("invalid fixture unexpectedly parsed");
      let error: unknown;
      try {
        parseStreamAppendInput(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues).toEqual(expected.error.issues);
    }
  });

  it("matches the canonical record acceptance boundary", () => {
    class RecordLike {
      value = 1;
    }

    const enumerableSymbol = Symbol("enumerable");
    const withEnumerableSymbol = { value: 1, [enumerableSymbol]: true };
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      value: 1,
    });
    const candidates: unknown[] = [
      { value: 1 },
      { value: 1, constructor: "event payload field" },
      nullPrototype,
      [],
      null,
      new Date(0),
      new Map([["value", 1]]),
      new RecordLike(),
      withEnumerableSymbol,
      "not-a-record",
    ];

    for (const payload of candidates) {
      const input = { type: "test/event", payload };
      expect(StreamAppendInput.safeParse(input).success).toBe(
        BaselineStreamAppendInput.safeParse(input).success,
      );
    }
  });

  it("preserves the canonical shallow-copy and key-normalization semantics", () => {
    const nested = { retainedByReference: true };
    const payload = JSON.parse('{"__proto__":{"polluted":true},"nested":{}}') as Record<
      string,
      unknown
    >;
    payload.nested = nested;
    const metadata = { traceId: "trace" };

    const parsed = StreamAppendInput.parse({
      type: " test/event ",
      payload,
      metadata,
      idempotencyKey: " key ",
      offset: 4,
    });

    expect(parsed).toEqual(
      BaselineStreamAppendInput.parse({
        type: " test/event ",
        payload,
        metadata,
        idempotencyKey: " key ",
        offset: 4,
      }),
    );
    expect(parsed.payload).not.toBe(payload);
    expect(parsed.metadata).not.toBe(metadata);
    expect(parsed.payload?.nested).toBe(nested);
    expect(Object.prototype.hasOwnProperty.call(parsed.payload, "__proto__")).toBe(false);
  });

  it("retains strict append-envelope validation", () => {
    expect(() => StreamAppendInput.parse({ type: "test/event", extra: true })).toThrow();
    expect(() => StreamAppendInput.parse({ type: "test/event", ephemeral: false })).toThrow();
    expect(() => StreamAppendInput.parse({ type: "test/event", offset: -1 })).toThrow();
  });
});
