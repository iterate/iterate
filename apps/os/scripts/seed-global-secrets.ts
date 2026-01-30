/**
 * Seeds global secrets into the database.
 *
 * Global secrets have null organizationId, projectId, and userId.
 * They are the lowest priority in the hierarchy and can be overridden.
 *
 * Usage: doppler run --config dev -- tsx apps/os/scripts/seed-global-secrets.ts
 */
import { and, isNull, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { typeid } from "typeid-js";
import * as schema from "../backend/db/schema.ts";
import { encryptWithSecret } from "../backend/utils/encryption-core.ts";

// Global secrets configuration: env var name -> secret key + egress rule + description
export const GLOBAL_SECRETS_CONFIG = [
  {
    envVar: "OPENAI_API_KEY",
    key: "iterate.openai_api_key",
    description: "OpenAI API key for AI features and language models",
    egressProxyRule: `url.hostname = 'api.openai.com'`,
  },
  {
    envVar: "ANTHROPIC_API_KEY",
    key: "iterate.anthropic_api_key",
    description: "Anthropic API key for Claude AI models",
    egressProxyRule: `url.hostname = 'api.anthropic.com'`,
  },
  {
    envVar: "RESEND_BOT_API_KEY",
    key: "iterate.resend_api_key",
    description: "Resend API key for sending transactional emails",
    // note: don't let ppl use this for reading emails or doing anything other than sending.
    // there is an additional check in the egress proxy to make sure you can always send to your own org's email addresses.
    egressProxyRule: `url.hostname = 'api.resend.com' and (url.pathname = '/emails' or url.pathname = '/emails/batch')`,
  },
  {
    envVar: "REPLICATE_API_TOKEN",
    key: "iterate.replicate_api_token",
    description:
      "Replicate API token for running AI models (image/video generation, speech synthesis, etc.)",
    egressProxyRule: `url.hostname = 'api.replicate.com'`,
  },
] as const satisfies Array<{
  envVar: string;
  key: string;
  description: string;
  egressProxyRule: string;
}>;

export type GlobalSecretEnvVarName =
  | (typeof GLOBAL_SECRETS_CONFIG)[number]["envVar"]
  | "PSCALE_DATABASE_URL"
  | "DATABASE_URL"
  | "ENCRYPTION_SECRET";

async function main() {
  const databaseUrl = process.env.PSCALE_DATABASE_URL || process.env.DATABASE_URL;
  const encryptionSecret = process.env.ENCRYPTION_SECRET;

  if (!databaseUrl) {
    console.error("DATABASE_URL or PSCALE_DATABASE_URL must be set");
    process.exit(1);
  }

  if (!encryptionSecret) {
    console.error("ENCRYPTION_SECRET must be set");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const db = drizzle(client, { schema, casing: "snake_case" });

  console.log("Seeding global secrets...");

  // Delete old global secrets that are no longer in the config
  const configKeys = GLOBAL_SECRETS_CONFIG.map((c) => c.key);
  const deleted = await db
    .delete(schema.secret)
    .where(
      and(
        isNull(schema.secret.organizationId),
        isNull(schema.secret.projectId),
        isNull(schema.secret.userId),
        notInArray(schema.secret.key, configKeys),
      ),
    )
    .returning({ key: schema.secret.key });

  if (deleted.length > 0) {
    console.log(
      `  🗑 Deleted ${deleted.length} old global secrets:`,
      deleted.map((d) => d.key),
    );
  }

  for (const config of GLOBAL_SECRETS_CONFIG) {
    const value = process.env[config.envVar];
    if (!value) {
      console.log(`  ⚠ Skipping ${config.key}: ${config.envVar} not set`);
      continue;
    }

    const encryptedValue = await encryptWithSecret(value, encryptionSecret);

    // Upsert: insert or update if exists
    await db
      .insert(schema.secret)
      .values({
        id: typeid("sec").toString() as `sec_${string}`,
        organizationId: null,
        projectId: null,
        userId: null,
        key: config.key,
        encryptedValue,
        description: config.description,
        egressProxyRule: config.egressProxyRule,
      })
      .onConflictDoUpdate({
        target: [
          schema.secret.organizationId,
          schema.secret.projectId,
          schema.secret.userId,
          schema.secret.key,
        ],
        set: {
          encryptedValue,
          description: config.description,
          egressProxyRule: config.egressProxyRule,
          updatedAt: new Date(),
        },
      });

    console.log(`  ✓ Seeded ${config.key}`);
  }

  await client.end();
  console.log("Done!");
}

main().catch((err) => {
  console.error("Failed to seed secrets:", err);
  process.exit(1);
});
