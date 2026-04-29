/**
 * Full pipeline: build TanStack Start app → create facet format → deploy
 * to the nested-facets Project DO.
 *
 * This mirrors what build-local.ts does for esbuild-based apps, but uses
 * Vite for the TanStack Start build step.
 *
 * Usage: npx tsx scripts/deploy-to-facet.ts
 *
 * Env vars:
 *   PROJECT_HOST  — e.g. "test.iterate-dev-jonas.app" (default)
 *   APP_NAME      — e.g. "tanstack-app" (default)
 */
import { execSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const NESTED_FACETS = join(ROOT, "../nested-facets");
const APP_NAME = process.env.APP_NAME || "tanstack-app";
const PROJECT_HOST = process.env.PROJECT_HOST || "test.iterate-dev-jonas.app";
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "cc7f6f461fbe823c199da2b27f9e0ff3";

// ── Step 1: Build with Vite ────────────────────────────────────────────────
console.log("Step 1: Building TanStack Start app with Vite...");
execSync("npx vite build", { cwd: ROOT, stdio: "inherit" });

// ── Step 2: Create facet dist format ───────────────────────────────────────
console.log("\nStep 2: Creating facet dist format...");

const VITE_SERVER = join(ROOT, "dist/server");
const VITE_CLIENT = join(ROOT, "dist/client");
const APP_DIST = join(NESTED_FACETS, "base-template/apps", APP_NAME, "dist");

// Clean and recreate
if (existsSync(APP_DIST)) rmSync(APP_DIST, { recursive: true });
mkdirSync(join(APP_DIST, "assets"), { recursive: true });

// ── Collect server modules ─────────────────────────────────────────────────

const serverModules: Record<string, string> = {};

// Read server entry
serverModules["server-entry.js"] = readFileSync(join(VITE_SERVER, "index.js"), "utf8");

// Read server asset chunks
const serverAssetsDir = join(VITE_SERVER, "assets");
if (existsSync(serverAssetsDir)) {
  for (const f of readdirSync(serverAssetsDir)) {
    if (f.endsWith(".js")) {
      serverModules[`assets/${f}`] = readFileSync(join(serverAssetsDir, f), "utf8");
    }
  }
}

// Create DO wrapper module.
// The wrapper imports the Vite server entry (which exports { fetch }) and
// wraps it in a class the LOADER recognises as "App".
serverModules["bundle.js"] = `
import handler from "./server-entry.js";

export class App {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      return await handler.fetch(request);
    } catch (err) {
      console.error("[TanStack Start Facet] SSR error:", err.message, err.stack);
      return new Response("Internal Server Error: " + err.message, { status: 500 });
    }
  }
}
`;

// Write server modules to dist
for (const [name, content] of Object.entries(serverModules)) {
  const outPath = join(APP_DIST, name);
  const dir = outPath.split("/").slice(0, -1).join("/");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, content);
}

// ── Collect client assets ──────────────────────────────────────────────────
// Client assets are served from dist/assets/{filename} by the Project DO.
// The assetFiles list uses leading-slash filenames WITHOUT "assets/" prefix,
// matching the format from @cloudflare/worker-bundler's createApp output.
// The Project DO serves them when:
//   request "/assets/foo.js" === `/assets${af}` where af = "/foo.js"

const clientAssetFiles: string[] = [];
const clientAssetsDir = join(VITE_CLIENT, "assets");
if (existsSync(clientAssetsDir)) {
  for (const f of readdirSync(clientAssetsDir)) {
    const content = readFileSync(join(clientAssetsDir, f), "utf8");
    writeFileSync(join(APP_DIST, "assets", f), content);
    // Leading slash, NO "assets/" prefix — matches serveDistAsset's `/assets${af}` pattern
    clientAssetFiles.push(`/${f}`);
  }
}

// NOTE: We intentionally do NOT create an index.html or include "/index.html"
// in assetFiles. TanStack Start does SSR, so all page navigations (GET /, /about,
// /counter) must fall through to the facet's fetch handler, which returns
// server-rendered HTML with <script> tags pointing to /assets/*.js.
// The SPA fallback in serveDistAsset won't trigger because:
//   1. No index.html exists in dist/assets/
//   2. Requests without file extensions reach the facet for SSR

// ── Write manifest ─────────────────────────────────────────────────────────

const manifest = {
  builtAt: new Date().toISOString(),
  mainModule: "bundle.js",
  moduleFiles: Object.keys(serverModules),
  assetFiles: clientAssetFiles,
};
writeFileSync(join(APP_DIST, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`  Server modules: ${manifest.moduleFiles.length}`);
manifest.moduleFiles.forEach((f) => {
  const size = serverModules[f].length;
  console.log(`    ${f} (${(size / 1024).toFixed(1)}KB)`);
});
console.log(`  Client assets: ${clientAssetFiles.length}`);
clientAssetFiles.forEach((f) => console.log(`    ${f}`));
console.log(
  `  Total server size: ${(Object.values(serverModules).reduce((a, b) => a + b.length, 0) / 1024).toFixed(0)}KB`,
);

// ── Step 3: Add to config.json if not already ──────────────────────────────
console.log("\nStep 3: Updating config.json...");
const configPath = join(NESTED_FACETS, "base-template/config.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as { apps: string[] };
if (!config.apps.includes(APP_NAME)) {
  config.apps.push(APP_NAME);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`  Added "${APP_NAME}" to config.json`);
} else {
  console.log(`  "${APP_NAME}" already in config.json`);
}

// ── Step 4: Sync source to artifact repo ───────────────────────────────────
console.log("\nStep 4: Syncing to artifact repo...");
execSync(
  `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} npx tsx scripts/sync-base-artifact.ts ./base-template`,
  { stdio: "inherit", cwd: NESTED_FACETS },
);

// ── Step 5: Rebase project ─────────────────────────────────────────────────
console.log("\nStep 5: Rebasing project...");
const rebaseResp = await fetch(`https://${PROJECT_HOST}/api/rebase?force=1`, {
  method: "POST",
  headers: { "x-level": "project" },
});
const rebaseData = (await rebaseResp.json()) as any;
console.log(`  Rebase: ${rebaseData.ok ? "ok" : "failed"}`);

// ── Step 6: Upload dist files ──────────────────────────────────────────────
console.log("\nStep 6: Uploading dist files...");

function readDirRecursive(dir: string, base: string = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full);
    const stat = statSync(full);
    if (stat.isDirectory()) Object.assign(files, readDirRecursive(full, base));
    else files[rel] = readFileSync(full, "utf8");
  }
  return files;
}

const distFiles = readDirRecursive(APP_DIST);
let uploaded = 0;
for (const [relPath, content] of Object.entries(distFiles)) {
  const apiPath = `apps/${APP_NAME}/dist/${relPath}`;
  const resp = await fetch(`https://${PROJECT_HOST}/api/files/${encodeURIComponent(apiPath)}`, {
    method: "PUT",
    headers: { "x-level": "project", "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const result = (await resp.json()) as any;
  if (!result.ok) {
    console.error(`  FAILED: ${apiPath}`, result.error);
  } else {
    uploaded++;
  }
}
console.log(`  Uploaded ${uploaded}/${Object.keys(distFiles).length} files`);

// ── Done ───────────────────────────────────────────────────────────────────
console.log(`\n=== Deploy Complete ===`);
console.log(`  App URL: https://${APP_NAME}.${PROJECT_HOST}`);
console.log(`  Project: https://${PROJECT_HOST}`);
