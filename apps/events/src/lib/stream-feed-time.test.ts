import { describe, expect, test } from "vitest";
import { formatElapsedTime } from "~/lib/stream-feed-time.ts";

describe("formatElapsedTime", () => {
  test("formats millisecond durations", () => {
    expect(formatElapsedTime(14)).toBe("+14ms");
  });

  test("formats sub-minute durations in seconds", () => {
    expect(formatElapsedTime(13_500)).toBe("+13.5s");
  });

  test("formats minute durations with minute and second parts", () => {
    expect(formatElapsedTime((123 * 60 + 41) * 1_000)).toBe("+123m41s");
  });
});
