import { describe, expect, test } from "vitest";
import { createSlug } from "./create-slug.ts";

describe("createSlug", () => {
  test("normalizes input into a slug", () => {
    expect(createSlug({ input: "Provider Contract / Docker" })).toBe("provider-contract-docker");
  });

  test("keeps both ends when truncation is needed", () => {
    const slug = createSlug({
      input:
        "provider contract docker supports create logs exec file io attach stop start and rootfs persistence across restart",
      maxLength: 24,
    });

    expect(slug).toMatch(/^[a-z0-9-]+--[a-f0-9]{6}--[a-z0-9-]+$/);
    expect(slug.length).toBeLessThanOrEqual(24);
    expect(slug.startsWith("provide")).toBe(true);
    expect(slug.endsWith("restart")).toBe(true);
  });

  test("falls back to unnamed when input has no slug-safe characters", () => {
    expect(createSlug({ input: "!!!" })).toBe("unnamed");
  });
});
