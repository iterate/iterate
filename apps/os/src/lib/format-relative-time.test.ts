import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./format-relative-time.ts";

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-09T12:00:00Z");
  const at = (iso: string) => formatRelativeTime(iso, now);

  it("is a pure function of (value, nowMs)", () => {
    expect(at("2026-07-09T12:00:00Z")).toBe("just now");
    expect(at("2026-07-09T11:59:30Z")).toBe("just now"); // sub-minute stays coarse
    expect(at("2026-07-09T11:57:00Z")).toBe("3 minutes ago");
    expect(at("2026-07-09T11:00:00Z")).toBe("1 hour ago");
    expect(at("2026-07-06T12:00:00Z")).toBe("3 days ago");
    expect(at("2026-07-09T14:00:00Z")).toBe("in 2 hours");
  });

  it("defaults nowMs to the clock for existing call sites", () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe("just now");
  });
});
