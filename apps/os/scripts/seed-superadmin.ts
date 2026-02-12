/**
 * Seeds global secrets into the database.
 *
 * Global secrets have null organizationId, projectId, and userId.
 * They are the lowest priority in the hierarchy and can be overridden.
 *
 * Usage: doppler run --config dev -- tsx apps/os/scripts/seed-global-secrets.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import * as schema from "../backend/db/schema.ts";

async function main() {
  const databaseUrl = process.env.PSCALE_DATABASE_URL || process.env.DATABASE_URL;
  const encryptionSecret = process.env.ENCRYPTION_SECRET;
  const password = process.env.SERVICE_AUTH_TOKEN;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL or PSCALE_DATABASE_URL must be set");
  }

  if (!encryptionSecret) {
    throw new Error("ENCRYPTION_SECRET must be set");
  }

  if (!password) {
    throw new Error("SERVICE_AUTH_TOKEN must be set");
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const db = drizzle(client, { schema, casing: "snake_case" });

  console.log("Seeding superadmin...");

  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.user)
      .values({
        email: "superadmin@nustom.com",
        name: "Super Admin",
        role: "admin",
        emailVerified: true,
      })
      .onConflictDoUpdate({
        target: [schema.user.email],
        set: {
          name: sql`excluded.name`,
          role: sql`excluded.role`,
          emailVerified: sql`excluded.email_verified`,
        },
      })
      .returning();
    await tx
      .insert(schema.account)
      .values({
        providerId: "credential",
        userId: user.id,
        password: await hashPassword(password),
        accountId: "superadmin",
      })
      .onConflictDoUpdate({
        target: [schema.account.accountId, schema.account.providerId],
        set: { password: sql`excluded.password` },
      });
  });
  await client.end();
  console.log("Done!");
}

// look for --run so we can import values from this file without running it immediately
if (process.argv.includes("--run")) {
  main().catch((err) => {
    console.error("Failed to seed superadmin:", err);
    process.exit(1);
  });
}
