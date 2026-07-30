import { describe, expect, it } from "vitest";
import { parseScheduleSetPayload } from "./scheduler-processor-contract.ts";
import type { ScheduleView } from "./types.ts";
import { sameScheduleDefinition } from "./types.ts";

function schedule(
  recurrence: ScheduleView["recurrence"],
  overrides: Partial<ScheduleView> = {},
): ScheduleView {
  return {
    action: { kind: "itx-script", script: "async () => undefined" },
    definedAtOffset: 7,
    key: "heartbeat",
    nextTriggerAt: "2026-07-23T12:00:00.000Z",
    recurrence,
    runCount: 4,
    setAt: "2026-07-23T11:00:00.000Z",
    ...overrides,
  };
}

describe("sameScheduleDefinition", () => {
  it.each([
    { name: "interval", recurrence: { every: 900 } },
    { name: "one-shot", recurrence: { at: "2026-07-24T00:00:00.000Z" } },
    {
      name: "zoned cron",
      recurrence: { cron: "0 9 * * 1", timezone: "Europe/London" },
    },
    { name: "UTC cron", recurrence: { cron: "0 9 * * 1" } },
  ] satisfies { name: string; recurrence: ScheduleView["recurrence"] }[])(
    "matches the $name recurrence",
    ({ recurrence }) => {
      const current = schedule(recurrence);
      const differentRuntime = schedule(recurrence, {
        definedAtOffset: 99,
        nextTriggerAt: null,
        runCount: 0,
        setAt: "2099-01-01T00:00:00.000Z",
      });
      expect(sameScheduleDefinition(current, differentRuntime)).toBe(true);
    },
  );

  it("compares action, recurrence, and nested metadata exactly but ignores object key order", () => {
    const current = schedule({ every: 900 }, { metadata: { a: { x: 1, y: [2, 3] }, b: true } });

    expect(
      sameScheduleDefinition(current, {
        ...current,
        metadata: { b: true, a: { y: [2, 3], x: 1 } },
      }),
    ).toBe(true);
    expect(
      sameScheduleDefinition(current, {
        ...current,
        action: { kind: "itx-script", script: "async () => 'changed'" },
      }),
    ).toBe(false);
    expect(sameScheduleDefinition(current, { ...current, recurrence: { every: 901 } })).toBe(false);
    expect(
      sameScheduleDefinition(current, {
        ...current,
        metadata: { a: { x: 1, y: [3, 2] }, b: true },
      }),
    ).toBe(false);
  });
});

describe("parseScheduleSetPayload", () => {
  const definition = {
    action: { kind: "itx-script" as const, script: "async () => undefined" },
    key: "heartbeat",
    recurrence: { every: 900 },
  };

  it("normalizes metadata exactly as stream JSON persistence does", () => {
    const parsed = parseScheduleSetPayload({
      ...definition,
      metadata: { negativeZero: -0, nested: { value: "ok" } },
    });
    expect(parsed.metadata).toEqual({ negativeZero: 0, nested: { value: "ok" } });
    expect(Object.is(parsed.metadata?.negativeZero, -0)).toBe(false);
  });

  it.each([{ invalid: NaN }, { invalid: [undefined] }, { invalid: { value: undefined } }])(
    "rejects non-JSON metadata: $invalid",
    ({ invalid }) => {
      expect(() => parseScheduleSetPayload({ ...definition, metadata: { invalid } })).toThrow();
    },
  );
});
