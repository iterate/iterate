import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Rebuilds the local dev sqlite from src/db/migrations/. Used only for sqlfu
// typegen; runtime code hits D1 through the sqlfu D1 adapter.

const cwd = process.cwd();
const dbPath = path.join(cwd, ".sqlfu/dev.sqlite");
const migrationsDir = path.join(cwd, "src/db/migrations");

await fs.mkdir(path.dirname(dbPath), { recursive: true });
await fs.rm(dbPath, { force: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  create table if not exists sqlfu_migrations (
    name text primary key check (name not like '%.sql'),
    checksum text not null,
    applied_at text not null
  );
`);

const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
const insert = db.prepare(
  `insert into sqlfu_migrations (name, checksum, applied_at) values (?, ?, ?)`,
);
for (const file of files) {
  const content = await fs.readFile(path.join(migrationsDir, file), "utf8");
  db.exec(content);
  const checksum = createHash("sha256").update(content).digest("hex");
  const name = file.replace(/\.sql$/, "");
  insert.run(name, checksum, new Date().toISOString());
}

// Workaround for sqlfu typegen bug: extractSchema orders by (type, name), so indices
// come before their tables when replayed into the typegen scratch db, causing
// "no such table". Dropping indices here is safe because typegen only needs table
// shapes. TODO: fix upstream in sqlfu core/sqlite.ts extractSchema ordering.
if (process.argv.includes("--for-generate")) {
  const indexRows = db
    .prepare(`select name from sqlite_schema where type='index' and name not like 'sqlite_%'`)
    .all();
  for (const row of indexRows) {
    db.exec(`drop index if exists "${row.name}";`);
  }
}

db.close();
console.log("dev sqlite ready at", dbPath);
