import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { findPatternConflicts, normalizePattern } from "./route-conflicts.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS route_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    target TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pattern)
  )`,
];

async function resetDb() {
  await env.DB.prepare("DROP TABLE IF EXISTS route_patterns").run();
  await env.DB.prepare("DROP TABLE IF EXISTS routes").run();
  for (const stmt of SCHEMA) await env.DB.prepare(stmt).run();
}

async function seed(routeId: string, pattern: string) {
  await env.DB.prepare(`INSERT OR IGNORE INTO routes (id, metadata) VALUES (?1, '{}')`).bind(routeId).run();
  await env.DB.prepare(
    `INSERT INTO route_patterns (route_id, pattern, target, headers) VALUES (?1, ?2, 'https://t.dev', '{}')`,
  ).bind(routeId, pattern).run();
}

beforeEach(resetDb);

describe("normalizePattern", () => {
  it.each([
    { input: "App.Project.ingress.iterate.com.", expected: "app.project.ingress.iterate.com" },
    { input: "HELLO.COM", expected: "hello.com" },
    { input: "*.example.com", expected: "*.example.com" },
    { input: "a-b.c-d.com", expected: "a-b.c-d.com" },
  ])("normalizes $input → $expected", ({ input, expected }) => {
    expect(normalizePattern(input)).toBe(expected);
  });

  it.each([
    { input: "bad pattern", reason: "spaces" },
    { input: "hello..com", reason: "double dots" },
    { input: "", reason: "empty" },
    { input: "   ", reason: "whitespace only" },
    { input: "foo/bar.com", reason: "slashes" },
    { input: "foo@bar.com", reason: "at sign" },
  ])("rejects invalid: $reason ($input)", ({ input }) => {
    expect(() => normalizePattern(input)).toThrow();
  });
});

describe("findPatternConflicts", () => {
  it("exact match returns conflict", async () => {
    await seed("rte_a", "app.project.ingress.iterate.com");

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["app.project.ingress.iterate.com", "*.project.ingress.iterate.com"],
    });

    expect(conflicts).toEqual([{ routeId: "rte_a", pattern: "app.project.ingress.iterate.com" }]);
  });

  it("excludeRouteId suppresses self conflicts", async () => {
    await seed("rte_a", "app.project.ingress.iterate.com");

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["app.project.ingress.iterate.com"],
      excludeRouteId: "rte_a",
    });

    expect(conflicts).toEqual([]);
  });

  it("detects conflicts across multiple routes", async () => {
    await seed("rte_a", "a.example.com");
    await seed("rte_b", "b.example.com");

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["a.example.com", "b.example.com", "c.example.com"],
    });

    expect(conflicts).toEqual([
      { routeId: "rte_a", pattern: "a.example.com" },
      { routeId: "rte_b", pattern: "b.example.com" },
    ]);
  });

  it("no conflicts when patterns don't overlap", async () => {
    await seed("rte_a", "a.example.com");

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["b.example.com", "c.example.com"],
    });

    expect(conflicts).toEqual([]);
  });

  it("empty patterns returns empty", async () => {
    await seed("rte_a", "a.example.com");
    expect(await findPatternConflicts({ db: env.DB, patterns: [] })).toEqual([]);
  });

  it("deduplicates input patterns", async () => {
    await seed("rte_a", "dup.example.com");

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["dup.example.com", "DUP.EXAMPLE.COM"],
    });

    expect(conflicts).toEqual([{ routeId: "rte_a", pattern: "dup.example.com" }]);
  });

  it("wildcard pattern stored in DB is matched literally", async () => {
    await seed("rte_a", "*.example.com");

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["*.example.com"],
    });

    expect(conflicts).toEqual([{ routeId: "rte_a", pattern: "*.example.com" }]);
  });

  it("excludeRouteId only suppresses the specified route", async () => {
    await seed("rte_a", "a.shared.example.com");
    await seed("rte_b", "b.shared.example.com");

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["a.shared.example.com", "b.shared.example.com"],
      excludeRouteId: "rte_a",
    });

    expect(conflicts).toEqual([{ routeId: "rte_b", pattern: "b.shared.example.com" }]);
  });
});
