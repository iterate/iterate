// scripts/d1.ts — the control plane's D1 on a Cloudflare account (src/control-plane/db/): found or
// created by name, and migrated by wrangler. `wrangler d1 migrations apply` sends each migration
// file with its `d1_migrations` history row as ONE request, so a file lands whole or not at all
// (https://developers.cloudflare.com/d1/reference/migrations/; workers-sdk
// packages/wrangler/src/d1/migrations/helpers.ts). sqlfu never migrates a D1 (sqlfu.config.ts). The
// deploys (scripts/deploy.ts: prd, main on dev and each per-commit deployment, scripts/preview.ts)
// migrate before their code uploads. Its own module, not in deploy.ts: trpc-cli turns deploy.ts's
// exports into commands.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runCloudflareCommandWith429Retry } from "../../../scripts/lib/deploy-helpers.ts";
import type { Cf } from "./preview-artifacts.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS_DIR = path.join(APP_ROOT, "src/control-plane/db/migrations");

export type D1Row = { uuid: string; name: string; created_at?: string };

/** The D1 named `name`, or undefined. The list API's `name` filter matches by prefix (measured), so
 *  the exact match is made here, over every page. */
async function findD1(cf: Cf, name: string) {
  for (let page = 1; ; page++) {
    const rows = await cf<D1Row[]>(`/d1/database?per_page=100&page=${page}`);
    const found = rows.find((row) => row.name === name);
    if (found || rows.length < 100) return found;
  }
}

/** The D1 named `name`, created when missing, never changed when found. Its primary is placed in
 *  western Europe, where most of the platform's traffic lands; the hint is only honoured at
 *  creation (https://developers.cloudflare.com/d1/configuration/data-location/). */
export async function ensureD1(cf: Cf, name: string) {
  const existing = await findD1(cf, name);
  if (existing) {
    console.log(`D1 ${name} exists (${existing.uuid})`);
    return existing;
  }
  const created = await cf<D1Row>("/d1/database", {
    method: "POST",
    body: JSON.stringify({ name, primary_location_hint: "weur" }),
  });
  console.log(`created D1 ${name} (${created.uuid})`);
  return created;
}

/** Apply every migration the D1 `databaseId` has not applied. The config wrangler reads names the
 *  database and nothing else, with an absolute `migrations_dir`: the deploy runs this before its
 *  build writes the Worker's own. A run cancelled after its request went out can still land that
 *  migration while the next run applies the same file, which then fails ("table … already
 *  exists") and rolls back: so a failed apply is checked once against the history, and passes
 *  when every migration file is applied after all. */
export async function applyD1Migrations(
  cf: Cf,
  input: {
    databaseName: string;
    databaseId: string;
    credentials: { CLOUDFLARE_API_TOKEN: string; CLOUDFLARE_ACCOUNT_ID: string };
  },
) {
  const dir = mkdtempSync(path.join(tmpdir(), "os-d1-"));
  const config = path.join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "os-d1-migrations",
      account_id: input.credentials.CLOUDFLARE_ACCOUNT_ID,
      d1_databases: [
        {
          binding: "DB",
          database_name: input.databaseName,
          database_id: input.databaseId,
          migrations_dir: MIGRATIONS_DIR,
        },
      ],
    }),
  );
  try {
    await runCloudflareCommandWith429Retry(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "-c", config],
      { cwd: APP_ROOT, env: input.credentials },
    );
  } catch (error) {
    // a first apply that failed before wrangler made its history table has none to read
    const [history] = await cf<{ results: unknown[] }[]>(`/d1/database/${input.databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "select name from d1_migrations" }),
    }).catch(() => {
      throw error;
    });
    const applied = new Set(
      z
        .array(z.object({ name: z.string() }))
        .parse(history?.results ?? [])
        .map((row) => row.name),
    );
    const pending = readdirSync(MIGRATIONS_DIR).filter(
      (name) => name.endsWith(".sql") && !applied.has(name),
    );
    if (pending.length) throw error;
    console.log(
      `D1 ${input.databaseName}: the apply failed, yet every migration is applied (another run landed it)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
