import { describe, it, expect } from "vitest";
import {
  PromptEventSchema,
  IterateEventSchema,
  isPromptEvent,
  isIterateEvent,
  extractIterateEvents,
} from "./events.ts";

describe("events schema", () => {
  it("accepts prompt events in both schemas", () => {
    const input = { type: "prompt", message: "hello" };
    expect(PromptEventSchema.parse(input)).toEqual(input);
    expect(IterateEventSchema.parse(input)).toEqual(input);
  });

  it("rejects non-prompt events", () => {
    expect(PromptEventSchema.safeParse({ type: "other", message: "x" }).success).toBe(false);
    expect(IterateEventSchema.safeParse({ type: "other", message: "x" }).success).toBe(false);
  });

  it("provides runtime type guards", () => {
    expect(isPromptEvent({ type: "prompt", message: "ok" })).toBe(true);
    expect(isPromptEvent({ type: "prompt", message: 1 })).toBe(false);
    expect(isIterateEvent({ type: "prompt", message: "ok" })).toBe(true);
    expect(isIterateEvent({ type: "other", message: "x" })).toBe(false);
  });

  it("extracts only valid iterate events", () => {
    expect(
      extractIterateEvents([
        { type: "prompt", message: "a" },
        { type: "prompt", message: 1 },
        { type: "other", message: "b" },
      ]),
    ).toEqual([{ type: "prompt", message: "a" }]);
    expect(extractIterateEvents({ type: "prompt", message: "one" })).toEqual([
      { type: "prompt", message: "one" },
    ]);
  });
});
