// Sync the base-template/ folder into the base-template artifact repo.
// This is a thin wrapper around scripts/sync-base-artifact.ts that also
// creates the repo if it doesn't exist.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=cc7f6f461fbe823c199da2b27f9e0ff3 npx tsx src/setup-base-artifact.ts
//
// Preferred: use scripts/sync-base-artifact.ts directly:
//   npx tsx scripts/sync-base-artifact.ts ./base-template

import path from "node:path";
import { execSync } from "node:child_process";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const baseTemplatePath = path.resolve(scriptDir, "../base-template");

console.log(`Syncing ${baseTemplatePath} to base-template artifact...`);
execSync(`npx tsx scripts/sync-base-artifact.ts "${baseTemplatePath}"`, {
  stdio: "inherit",
  cwd: path.resolve(scriptDir, ".."),
  env: { ...process.env },
});
