import { describe, expect, test } from "vitest";
import { mergeProcessorConfig } from "iterate/processors";

describe("mergeProcessorConfig", () => {
  test("recurses through plain objects and retains omitted keys", () => {
    expect(
      mergeProcessorConfig(
        {
          feature: { enabled: true, limits: { daily: 10, monthly: 100 } },
          retained: "yes",
        },
        { feature: { limits: { daily: 20 } } },
      ),
    ).toEqual({
      feature: { enabled: true, limits: { daily: 20, monthly: 100 } },
      retained: "yes",
    });
  });

  test("replaces arrays, scalars, and null wholesale", () => {
    expect(
      mergeProcessorConfig(
        { array: [1, 2], nullable: { nested: true }, scalar: "before" },
        { array: [3], nullable: null, scalar: "after" },
      ),
    ).toEqual({ array: [3], nullable: null, scalar: "after" });
  });
});
