import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashPassword } from "better-auth/crypto";

const BOOTSTRAP_SUPERADMIN_EMAIL = "superadmin@nustom.com";
const BOOTSTRAP_SUPERADMIN_NAME = "Super Admin";
const BOOTSTRAP_SUPERADMIN_ROLE = "admin";
const BOOTSTRAP_SUPERADMIN_ACCOUNT_ID = "superadmin";
const BOOTSTRAP_SUPERADMIN_ACCOUNT_ROW_ID = "acc_bootstrap_superadmin";
const BOOTSTRAP_SUPERADMIN_USER_ID = "usr_bootstrap_superadmin";

function escapeSqlString(value: string) {
  return value.replaceAll("'", "''");
}

async function main() {
  const outputPathArg = process.argv[2];
  if (!outputPathArg) {
    throw new Error("Output path is required");
  }

  const serviceAuthToken = process.env.SERVICE_AUTH_TOKEN?.trim();
  if (!serviceAuthToken) {
    throw new Error("SERVICE_AUTH_TOKEN is required");
  }

  const outputPath = resolve(outputPathArg);
  mkdirSync(dirname(outputPath), { recursive: true });

  const now = new Date().toISOString();
  const passwordHash = await hashPassword(serviceAuthToken);

  const sql = `
INSERT INTO user (
  id,
  name,
  email,
  emailVerified,
  image,
  role,
  createdAt,
  updatedAt
)
VALUES (
  '${escapeSqlString(BOOTSTRAP_SUPERADMIN_USER_ID)}',
  '${escapeSqlString(BOOTSTRAP_SUPERADMIN_NAME)}',
  '${escapeSqlString(BOOTSTRAP_SUPERADMIN_EMAIL)}',
  1,
  NULL,
  '${escapeSqlString(BOOTSTRAP_SUPERADMIN_ROLE)}',
  '${escapeSqlString(now)}',
  '${escapeSqlString(now)}'
)
ON CONFLICT(email) DO UPDATE SET
  name = excluded.name,
  emailVerified = excluded.emailVerified,
  role = excluded.role,
  updatedAt = excluded.updatedAt;

DELETE FROM account
WHERE accountId = '${escapeSqlString(BOOTSTRAP_SUPERADMIN_ACCOUNT_ID)}'
  AND providerId = 'credential';

INSERT INTO account (
  id,
  accountId,
  providerId,
  userId,
  password,
  createdAt,
  updatedAt
)
VALUES (
  '${escapeSqlString(BOOTSTRAP_SUPERADMIN_ACCOUNT_ROW_ID)}',
  '${escapeSqlString(BOOTSTRAP_SUPERADMIN_ACCOUNT_ID)}',
  'credential',
  (SELECT id FROM user WHERE email = '${escapeSqlString(BOOTSTRAP_SUPERADMIN_EMAIL)}'),
  '${escapeSqlString(passwordHash)}',
  '${escapeSqlString(now)}',
  '${escapeSqlString(now)}'
);
`.trimStart();

  writeFileSync(outputPath, sql);
  console.log(`Rendered superadmin seed SQL to ${outputPath}`);
}

await main();
