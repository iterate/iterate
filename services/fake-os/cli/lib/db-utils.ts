import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = join(serviceRoot, "drizzle");
const tempDbPath = join(serviceRoot, "data/.drizzle-tmp.sqlite");
const schemaOutputPath = join(serviceRoot, "drizzle/schema.sql");

export function getServiceRoot() {
  return serviceRoot;
}

export function getTempDbPath() {
  return tempDbPath;
}

export function getSchemaOutputPath() {
  return schemaOutputPath;
}

export function listMigrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort()
    .map((name) => join(migrationsDir, name));
}

export function assertUniqueMigrationIds() {
  const migrationIds = new Map<string, string>();
  for (const filePath of listMigrationFiles()) {
    const fileName = filePath.split("/").at(-1) ?? filePath;
    const migrationId = fileName.match(/^(\d+)/u)?.[1];
    if (!migrationId) {
      throw new Error(`Could not extract migration id from ${fileName}`);
    }
    const existing = migrationIds.get(migrationId);
    if (existing) {
      throw new Error(
        `Duplicate migration id ${migrationId}: ${existing} and ${fileName}. Regenerate one migration with a new prefix before committing.`,
      );
    }
    migrationIds.set(migrationId, fileName);
  }
}

export function rebuildTempDb() {
  assertUniqueMigrationIds();
  rmSync(tempDbPath, { force: true });
  mkdirSync(dirname(tempDbPath), { recursive: true });
  const sqlite = drizzle(tempDbPath).$client;

  for (const filePath of listMigrationFiles()) {
    sqlite.exec(readFileSync(filePath, "utf8"));
  }

  sqlite.close();
  return tempDbPath;
}

export function dumpSchemaFile(dbPath: string) {
  mkdirSync(dirname(schemaOutputPath), { recursive: true });
  const result = spawnSync("sqlite3", [dbPath, ".schema --indent"], {
    cwd: serviceRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "sqlite3 schema dump failed");
  }
  writeFileSync(schemaOutputPath, `${result.stdout.trimEnd()}\n`);
  return schemaOutputPath;
}

export function previewSchemaDiff(dbPath: string) {
  const result = spawnSync(
    "pnpm",
    ["exec", "drizzle-kit", "push", "--config", "drizzle.config.ts", "--verbose", "--force"],
    {
      cwd: serviceRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: dbPath,
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`drizzle-kit push preview failed with exit code ${result.status ?? "unknown"}`);
  }
}
