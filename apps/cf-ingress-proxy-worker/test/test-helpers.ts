import migration0001Sql from "../migrations/0001_init.sql?raw";
import migration0002Sql from "../migrations/0002_route_external_id.sql?raw";

const TEST_SCHEMA_STATEMENTS = [migration0001Sql, migration0002Sql].flatMap((migrationSql) => {
  return migrationSql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
});

export async function resetDb(db: D1Database): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS route_patterns").run();
  await db.prepare("DROP TABLE IF EXISTS routes").run();

  for (const statement of TEST_SCHEMA_STATEMENTS) {
    await db.prepare(statement).run();
  }
}
