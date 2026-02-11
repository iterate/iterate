/* eslint-disable no-console -- standalone CLI script, not a worker */
/**
 * Reconciliation script: move stuck machines with empty externalId to `failed` state.
 *
 * Targets machines that:
 *   - Have externalId="" (provisioning never completed)
 *   - Are in a non-terminal state (starting or detached)
 *   - Are older than a configurable threshold (default 30 minutes)
 *
 * Usage (from apps/os/):
 *   doppler run --config prd -- npx tsx backend/scripts/reconcile-stuck-machines.ts [--dry-run]
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, lt, or } from "drizzle-orm";
import * as schema from "../db/schema.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

async function main() {
  const dbUrl = process.env.PSCALE_DATABASE_URL ?? process.env.PLANETSCALE_PROD_POSTGRES_URL;
  if (!dbUrl) {
    console.error("Missing PSCALE_DATABASE_URL or PLANETSCALE_PROD_POSTGRES_URL");
    process.exit(1);
  }

  const client = postgres(dbUrl, { prepare: false, ssl: "require" });
  const db = drizzle(client, { schema });

  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);

  const stuckMachines = await db.query.machine.findMany({
    where: and(
      eq(schema.machine.externalId, ""),
      or(eq(schema.machine.state, "starting"), eq(schema.machine.state, "detached")),
      lt(schema.machine.createdAt, cutoff),
    ),
  });

  console.log(
    `Found ${stuckMachines.length} stuck machine(s) older than ${STUCK_THRESHOLD_MS / 60_000}m`,
  );

  for (const m of stuckMachines) {
    const metadata = (m.metadata as Record<string, unknown>) ?? {};
    console.log(
      `  ${m.id} | state=${m.state} | created=${m.createdAt.toISOString()} | provisioningError=${metadata.provisioningError ?? "none"}`,
    );

    if (!DRY_RUN) {
      await db
        .update(schema.machine)
        .set({
          state: "failed",
          metadata: {
            ...metadata,
            reconciledAt: new Date().toISOString(),
            reconciledReason: "stuck with empty externalId",
          },
        })
        .where(eq(schema.machine.id, m.id));
      console.log(`    -> moved to failed`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDry run — no changes made. Remove --dry-run to apply.");
  } else {
    console.log(`\nReconciled ${stuckMachines.length} machine(s).`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
