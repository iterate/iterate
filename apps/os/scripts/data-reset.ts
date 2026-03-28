import pg from "pg";
import { resolveLocalDockerPostgresPort } from "./local-docker-postgres-port.ts";
import { seedGlobalSecrets } from "./seed-global-secrets.ts";
import { seedSuperadmin } from "./seed-superadmin.ts";

function getDatabaseUrl() {
  return (
    process.env.PSCALE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    `postgres://postgres:postgres@localhost:${resolveLocalDockerPostgresPort()}/os`
  );
}

function assertLocalDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const allowedHosts = new Set(["localhost", "127.0.0.1"]);
  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`Refusing to reset non-local database: ${url.hostname}`);
  }
}

async function truncateTables(client: pg.Client, schemaName: string, excludeTables: string[] = []) {
  const { rows } = await client.query<{ tablename: string }>(
    `
      select tablename
      from pg_tables
      where schemaname = $1
        and not (tablename = any($2::text[]))
      order by tablename
    `,
    [schemaName, excludeTables],
  );

  if (rows.length === 0) {
    return;
  }

  const tableList = rows
    .map(({ tablename }) => `"${schemaName}"."${tablename.replaceAll('"', '""')}"`)
    .join(", ");
  await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

export async function dataReset() {
  const databaseUrl = getDatabaseUrl();
  assertLocalDatabase(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  console.log(`Resetting local OS data in ${databaseUrl}`);
  await truncateTables(client, "public", ["__drizzle_migrations"]);
  await truncateTables(client, "pgmq");
  await client.end();

  await seedGlobalSecrets();
  await seedSuperadmin();
}

if (process.argv[1]) {
  dataReset().catch((error) => {
    console.error("Failed to reset data:", error);
    process.exit(1);
  });
}
