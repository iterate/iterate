import { describe, expect, test } from "vitest";
import { getNextAppendEventOffset, getNextEventOffset } from "./offset.ts";

describe("getNextEventOffset", () => {
  test("returns the first stored offset when there is no previous offset", () => {
    expect(getNextEventOffset(null)).toBe("0000000000000000");
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

describe("getNextAppendEventOffset", () => {
  test("returns 1 for the first caller-appended event on an untouched stream", () => {
    expect(
      getNextAppendEventOffset({
        initialized: false,
        lastOffset: null,
      }),
    ).toBe("0000000000000001");
  });

  test("returns the next stored offset for initialized streams", () => {
    expect(
      getNextAppendEventOffset({
        initialized: true,
        lastOffset: "0000000000000000",
      }),
    ).toBe("0000000000000001");
  });
});
