import { describe, expect, test } from "vitest";
import { getNextEventOffset } from "./offset.ts";

describe("getNextEventOffset", () => {
  test("returns the first canonical offset when there is no previous offset", () => {
    expect(getNextEventOffset(null)).toBe("0000000000000001");
  });

  test("increments canonical offsets while preserving width", () => {
    expect(getNextEventOffset("0000000000000001")).toBe("0000000000000002");
    expect(getNextEventOffset("0000000000000099")).toBe("0000000000000100");
  });

  test("grows width when the previous offset overflows its digits", () => {
    expect(getNextEventOffset("9999999999999999")).toBe("10000000000000000");
  });

  test("rejects non-numeric offsets", () => {
    expect(() => getNextEventOffset("banana")).toThrow(/non-numeric/i);
  });
});
