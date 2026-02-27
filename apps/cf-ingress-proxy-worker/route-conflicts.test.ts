import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { findPatternConflicts, normalizePattern } from "./route-conflicts.ts";

const TEST_SCHEMA_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`,
  `
  CREATE TABLE IF NOT EXISTS route_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    target TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pattern)
  )
`,
];

async function resetDb(): Promise<void> {
  await env.DB.prepare("DROP TABLE IF EXISTS route_patterns").run();
  await env.DB.prepare("DROP TABLE IF EXISTS routes").run();
  for (const statement of TEST_SCHEMA_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
}

beforeEach(async () => {
  await resetDb();
});

describe("normalizePattern", () => {
  test("normalizes case and trailing dot", () => {
    expect(normalizePattern("App.Project.ingress.iterate.com.")).toBe(
      "app.project.ingress.iterate.com",
    );
  });

  test("rejects invalid pattern characters", () => {
    expect(() => normalizePattern("bad pattern")).toThrow("Invalid pattern");
  });
});

describe("findPatternConflicts", () => {
  test("returns conflicts by exact pattern match", async () => {
    await env.DB.prepare(`INSERT INTO routes (id, metadata) VALUES (?1, '{}')`).bind("rte_a").run();
    await env.DB.prepare(
      `INSERT INTO route_patterns (route_id, pattern, target, headers) VALUES (?1, ?2, ?3, '{}')`,
    )
      .bind("rte_a", "app.project.ingress.iterate.com", "https://one.fly.dev")
      .run();

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["app.project.ingress.iterate.com", "*.project.ingress.iterate.com"],
    });

    expect(conflicts).toEqual([{ routeId: "rte_a", pattern: "app.project.ingress.iterate.com" }]);
  });

  test("excludeRouteId suppresses self conflicts", async () => {
    await env.DB.prepare(`INSERT INTO routes (id, metadata) VALUES (?1, '{}')`).bind("rte_a").run();
    await env.DB.prepare(
      `INSERT INTO route_patterns (route_id, pattern, target, headers) VALUES (?1, ?2, ?3, '{}')`,
    )
      .bind("rte_a", "app.project.ingress.iterate.com", "https://one.fly.dev")
      .run();

    const conflicts = await findPatternConflicts({
      db: env.DB,
      patterns: ["app.project.ingress.iterate.com"],
      excludeRouteId: "rte_a",
    });

    expect(conflicts).toEqual([]);
  });
});
