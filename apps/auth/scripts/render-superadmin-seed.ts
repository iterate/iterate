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
// create-hook in auth.ts handles new signups. minimatch supports far more
// syntax (braces, character classes, negation) than LIKE can express, so we
// refuse anything beyond the * and ? wildcards — failing the deploy beats
// silently promoting a different set of users here than the signup hook does.
// For email strings (which never contain "/"), * and ? translate exactly.
function allowlistPatternToSqlLike(pattern: string) {
  if (!/^[a-z0-9*?@._+-]+$/.test(pattern)) {
    throw new Error(
      `SUPERADMIN_ALLOWLIST pattern "${pattern}" uses minimatch syntax the deploy-time SQL ` +
        `backfill cannot translate; only the * and ? wildcards are supported.`,
    );
  }
  return escapeSqlString(
    pattern.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"),
  )
    .replaceAll("*", "%")
    .replaceAll("?", "_");
}

// Each pattern's backfill runs exactly once, tracked in superadminBackfill:
// the seed file re-imports on every deploy (its rendered timestamp changes the
// file hash), and without the marker a superadmin demoted via the admin API
// would be re-promoted by the next deploy. New signups are promoted by the
// auth.ts hook, so the backfill only needs to catch users who existed before
// their pattern was allowlisted.
function renderSuperadminBackfillSql(allowlist: string[], now: string) {
  if (allowlist.length === 0) {
    return "";
  }

  const statements = allowlist.map((pattern) => {
    const like = allowlistPatternToSqlLike(pattern);
    const marker = escapeSqlString(pattern);
    return `
UPDATE user
SET role = 'admin',
    updatedAt = '${escapeSqlString(now)}'
WHERE lower(email) LIKE '${like}' ESCAPE '\\'
  AND (role IS NULL OR role != 'admin')
  AND NOT EXISTS (SELECT 1 FROM superadminBackfill WHERE pattern = '${marker}');

INSERT OR IGNORE INTO superadminBackfill (pattern, appliedAt)
VALUES ('${marker}', '${escapeSqlString(now)}');
`;
  });

  return `
CREATE TABLE IF NOT EXISTS superadminBackfill (
  pattern TEXT PRIMARY KEY,
  appliedAt TEXT NOT NULL
);
${statements.join("")}`;
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
