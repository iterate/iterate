import { describe, expect, it } from "vitest";
import { formatRelativeTime, formatTimeAgo } from "./format-relative-time.ts";

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

describe("formatTimeAgo", () => {
  const now = Date.parse("2026-07-09T12:00:00Z");

  it("never says a past event is in the future — skewed-fresh clamps to 'just now'", () => {
    // Server↔browser clock skew (or a caller's coarse clock tick) can stamp
    // an event a few seconds "ahead" of the reader's clock.
    expect(formatTimeAgo("2026-07-09T12:00:04Z", now)).toBe("just now");
    expect(formatTimeAgo("2026-07-09T12:03:00Z", now)).toBe("just now"); // even wild skew
    expect(formatRelativeTime("2026-07-09T12:03:00Z", now)).toBe("in 3 minutes"); // the two-sided form, for contrast
  });

  it("formats genuinely past events like formatRelativeTime", () => {
    expect(formatTimeAgo("2026-07-09T11:57:00Z", now)).toBe("3 minutes ago");
    expect(formatTimeAgo("2026-07-06T12:00:00Z", now)).toBe("3 days ago");
  });
});
