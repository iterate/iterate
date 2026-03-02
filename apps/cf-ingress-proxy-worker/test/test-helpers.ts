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
  `
  CREATE INDEX IF NOT EXISTS idx_route_patterns_route_id ON route_patterns(route_id)
`,
  `
  CREATE INDEX IF NOT EXISTS idx_route_patterns_pattern_length ON route_patterns(length(pattern))
`,
];

export async function resetDb(db: D1Database): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS route_patterns").run();
  await db.prepare("DROP TABLE IF EXISTS routes").run();

  for (const statement of TEST_SCHEMA_STATEMENTS) {
    await db.prepare(statement).run();
  }
}
