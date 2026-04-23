/**
 * Deploy script: push source to artifact repo, then trigger a sandbox build.
 *
 * Usage: npx tsx scripts/deploy.ts
 *
 * Steps:
 *   1. Sync base-template (with app source) to artifact repo
 *   2. Rebase the Project DO from the artifact
 *   3. Trigger sandbox Vite build via POST /api/build-vite/tanstack-app
 *   4. Report result
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, rmSync, existsSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TSF = join(__dirname, "..");
const NF = join(TSF, "../nested-facets");
const APP_DEST = join(NF, "base-template/apps/tanstack-app");
const ACCOUNT_ID = "cc7f6f461fbe823c199da2b27f9e0ff3";
const PROJECT_HOST = "test.iterate-dev-jonas.app";

// ── 1. Copy source to base-template ────────────────────────────────────────
console.log("1. Copying source to base-template...");

// Clean destination (keep package.json buildConfig)
for (const dir of ["src", "dist", "facet-dist"]) {
  const p = join(APP_DEST, dir);
  if (existsSync(p)) rmSync(p, { recursive: true });
}

// Copy source files the app needs
cpSync(join(TSF, "src"), join(APP_DEST, "src"), { recursive: true });
cpSync(join(TSF, "drizzle"), join(APP_DEST, "drizzle"), { recursive: true });
cpSync(join(TSF, "drizzle.config.ts"), join(APP_DEST, "drizzle.config.ts"));
cpSync(join(TSF, "package.json"), join(APP_DEST, "package.json"));
cpSync(join(TSF, "package-lock.json"), join(APP_DEST, "package-lock.json"));
cpSync(join(TSF, "vite.config.ts"), join(APP_DEST, "vite.config.ts"));
cpSync(join(TSF, "wrangler.jsonc"), join(APP_DEST, "wrangler.jsonc"));
cpSync(join(TSF, "tsconfig.json"), join(APP_DEST, "tsconfig.json"));

console.log("   Done.");

// ── 2. Sync artifact repo ──────────────────────────────────────────────────
console.log("2. Syncing artifact repo...");
execSync(
  `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} npx tsx scripts/sync-base-artifact.ts ./base-template`,
  { stdio: "inherit", cwd: NF },
);

// ── 3. Rebase Project DO ───────────────────────────────────────────────────
console.log("\n3. Rebasing project...");
const rebaseResp = await fetch(`https://${PROJECT_HOST}/api/rebase?force=1`, {
  method: "POST",
  headers: { "x-level": "project" },
});
const rebaseData = (await rebaseResp.json()) as any;
console.log(`   Rebase: ${rebaseData.ok ? "ok" : "FAILED"}`);

// ── 4. Trigger sandbox build ───────────────────────────────────────────────
console.log("\n4. Triggering sandbox Vite build...");
console.log("   (This spins up a Cloudflare Container, runs npm install + vite build)");

const buildStart = Date.now();
const buildResp = await fetch(`https://${PROJECT_HOST}/api/build-vite/tanstack-app`, {
  method: "POST",
  headers: { "x-level": "project" },
});
const buildData = (await buildResp.json()) as any;
const elapsed = ((Date.now() - buildStart) / 1000).toFixed(1);

if (buildData.ok) {
  console.log(`\n   BUILD SUCCESS (${elapsed}s)`);
  console.log(`   Server modules: ${buildData.moduleFiles?.length ?? "?"}`);
  console.log(`   Client assets: ${buildData.assetFiles?.length ?? "?"}`);
  console.log(`\n   Live at: https://tanstack-app.${PROJECT_HOST}`);
} else {
  console.error(`\n   BUILD FAILED (${elapsed}s)`);
  console.error(`   Error: ${buildData.error?.slice(0, 500)}`);
  process.exit(1);
}
