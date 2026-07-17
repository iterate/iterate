import { describe, expect, it } from "vitest";
import { StreamEventInput } from "./schemas.ts";

describe("stream event identifiers", () => {
  it("accepts a bounded URI-like operational schema identifier", () => {
    const type = `custom/${"x".repeat(249)}`;
    expect(type).toHaveLength(256);
    expect(StreamEventInput.parse({ type })).toEqual({ type });
  });

  it.each([
    "",
    " event/with-leading-space",
    "event type with user content",
    "event/with-a-secret\nAuthorization: bearer value",
    `custom/${"x".repeat(250)}`,
  ])("rejects a non-identifier event type %#", (type) => {
    expect(StreamEventInput.safeParse({ type }).success).toBe(false);
  });
});
