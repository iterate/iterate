import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { findPatternConflicts, normalizePattern } from "./route-conflicts.ts";
import { resetDb } from "./test/test-helpers.ts";

const testEnv = env as { DB: D1Database };

async function seedPattern(routeId: string, pattern: string): Promise<void> {
  await testEnv.DB.prepare(`INSERT INTO routes (id, metadata) VALUES (?1, '{}')`)
    .bind(routeId)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO route_patterns (route_id, pattern, target, headers) VALUES (?1, ?2, ?3, '{}')`,
  )
    .bind(routeId, pattern, "https://one.fly.dev")
    .run();
}

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
  ])("rejects invalid pattern %j", (input, message) => {
    expect(() => normalizePattern(input)).toThrow(message);
  });
});

describe("findPatternConflicts", () => {
  it("returns conflicts by exact pattern match", async () => {
    await seedPattern("rte_a", "app.project.ingress.iterate.com");

    const conflicts = await findPatternConflicts({
      db: testEnv.DB,
      patterns: ["app.project.ingress.iterate.com", "*.project.ingress.iterate.com"],
    });

    expect(conflicts).toEqual([{ routeId: "rte_a", pattern: "app.project.ingress.iterate.com" }]);
  });

  it("normalizes query patterns before conflict lookup", async () => {
    await seedPattern("rte_a", "app.project.ingress.iterate.com");

    const conflicts = await findPatternConflicts({
      db: testEnv.DB,
      patterns: ["App.Project.ingress.iterate.com."],
    });

    expect(conflicts).toEqual([{ routeId: "rte_a", pattern: "app.project.ingress.iterate.com" }]);
  });

  it("deduplicates duplicate request patterns", async () => {
    await seedPattern("rte_a", "app.project.ingress.iterate.com");

    const conflicts = await findPatternConflicts({
      db: testEnv.DB,
      patterns: [
        "app.project.ingress.iterate.com",
        "app.project.ingress.iterate.com",
        "App.Project.ingress.iterate.com.",
      ],
    });

    expect(conflicts).toEqual([{ routeId: "rte_a", pattern: "app.project.ingress.iterate.com" }]);
  });

  it("excludeRouteId suppresses self conflicts and trims input", async () => {
    await seedPattern("rte_a", "app.project.ingress.iterate.com");

    const conflicts = await findPatternConflicts({
      db: testEnv.DB,
      patterns: ["app.project.ingress.iterate.com"],
      excludeRouteId: "  rte_a  ",
    });

    expect(conflicts).toEqual([]);
  });

  it("accepts pre-normalized patterns without re-normalizing", async () => {
    await seedPattern("rte_a", "app.project.ingress.iterate.com");

    const conflicts = await findPatternConflicts({
      db: testEnv.DB,
      patterns: ["app.project.ingress.iterate.com"],
      patternsAreNormalized: true,
    });

    expect(conflicts).toEqual([{ routeId: "rte_a", pattern: "app.project.ingress.iterate.com" }]);
  });
});
