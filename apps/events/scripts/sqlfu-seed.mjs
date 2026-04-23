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

db.close();
console.log("dev sqlite ready at", dbPath);
