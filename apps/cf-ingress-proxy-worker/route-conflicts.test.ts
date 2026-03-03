import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_PATTERN_LENGTH, normalizePattern } from "./route-conflicts.ts";
import { resetDb } from "./test/test-helpers.ts";

const testEnv = env as { DB: D1Database };

beforeEach(async () => {
  await resetDb(testEnv.DB);
});

describe("normalizePattern", () => {
  it.each([
    ["App.Project.ingress.iterate.com.", "app.project.ingress.iterate.com"],
    ["*.PROJECT.ingress.iterate.com", "*.project.ingress.iterate.com"],
    ["  app.project.ingress.iterate.com  ", "app.project.ingress.iterate.com"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizePattern(input)).toBe(expected);
  });

  it.each([
    ["", "pattern is required"],
    ["   ", "pattern is required"],
    ["bad pattern", "Invalid pattern"],
    ["a..b.iterate.com", "Invalid pattern"],
    ["app/project.iterate.com", "Invalid pattern"],
    ["*project.ingress.iterate.com", "Invalid pattern"],
    ["proj*ect.ingress.iterate.com", "Invalid pattern"],
    ["*.*.ingress.iterate.com", "Invalid pattern"],
    ["*..", "Invalid pattern"],
    ["*-", "Invalid pattern"],
    ["*_", "Invalid pattern"],
    ["*.", "Invalid pattern"],
    ["a".repeat(MAX_PATTERN_LENGTH + 1), "Invalid pattern"],
  ])("rejects invalid pattern %j", (input, message) => {
    expect(() => normalizePattern(input)).toThrow(message);
  });
});
