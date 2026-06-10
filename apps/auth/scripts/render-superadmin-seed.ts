import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { parseSignupAllowlist } from "@iterate-com/shared/signup-allowlist";
import {
  BOOTSTRAP_SUPERADMIN_ACCOUNT_ID,
  BOOTSTRAP_SUPERADMIN_ACCOUNT_ROW_ID,
  BOOTSTRAP_SUPERADMIN_EMAIL,
  BOOTSTRAP_SUPERADMIN_NAME,
  BOOTSTRAP_SUPERADMIN_ROLE,
  BOOTSTRAP_SUPERADMIN_USER_ID,
} from "../src/server/bootstrap-superadmin.ts";

function escapeSqlString(value: string) {
  return value.replaceAll("'", "''");
}

// Translates the minimatch-style allowlist patterns ("*@nustom.com") into SQL
// LIKE patterns so the seed can promote pre-existing users at deploy time; the
// create-hook in auth.ts handles new signups.
function allowlistPatternToSqlLike(pattern: string) {
  return escapeSqlString(
    pattern.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"),
  )
    .replaceAll("*", "%")
    .replaceAll("?", "_");
}

function renderSuperadminBackfillSql(allowlist: string[], now: string) {
  if (allowlist.length === 0) {
    return "";
  }

  const conditions = allowlist
    .map((pattern) => `lower(email) LIKE '${allowlistPatternToSqlLike(pattern)}' ESCAPE '\\'`)
    .join("\n   OR ");

  return `
UPDATE user
SET role = 'admin',
    updatedAt = '${escapeSqlString(now)}'
WHERE (${conditions})
  AND (role IS NULL OR role != 'admin');
`;
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

  const superadminAllowlist = parseSignupAllowlist(process.env.SUPERADMIN_ALLOWLIST ?? "");

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
${renderSuperadminBackfillSql(superadminAllowlist, now)}`.trimStart();

  writeFileSync(outputPath, sql);
  console.log(`Rendered superadmin seed SQL to ${outputPath}`);
}

await main();
