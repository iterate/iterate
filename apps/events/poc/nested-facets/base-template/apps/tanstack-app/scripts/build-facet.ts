/**
 * Post-build: transform Vite output into nested-facets LOADER format.
 *
 * The app's src/server.ts exports `class App extends DurableObject` directly,
 * so no wrapper is needed — the Vite server entry IS the main module.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const VITE_SERVER = join(ROOT, "dist/server");
const VITE_CLIENT = join(ROOT, "dist/client");
const FACET_DIST = join(ROOT, "facet-dist");

if (existsSync(FACET_DIST)) rmSync(FACET_DIST, { recursive: true });
mkdirSync(join(FACET_DIST, "assets"), { recursive: true });

// ── Server modules (Vite output — no wrapper needed) ───────────────────────
const serverModules: Record<string, string> = {};

// The main entry — already exports `class App extends DurableObject`
serverModules["index.js"] = readFileSync(join(VITE_SERVER, "index.js"), "utf8");

const serverAssetsDir = join(VITE_SERVER, "assets");
if (existsSync(serverAssetsDir)) {
  for (const f of readdirSync(serverAssetsDir)) {
    serverModules[`assets/${f}`] = readFileSync(join(serverAssetsDir, f), "utf8");
  }
}

// ── Client assets ──────────────────────────────────────────────────────────
const clientAssetFiles: string[] = [];
const clientAssetsDir = join(VITE_CLIENT, "assets");
if (existsSync(clientAssetsDir)) {
  for (const f of readdirSync(clientAssetsDir)) {
    writeFileSync(join(FACET_DIST, "assets", f), readFileSync(join(clientAssetsDir, f)));
    clientAssetFiles.push(`/${f}`);
  }
}

// ── Write modules ──────────────────────────────────────────────────────────
for (const [name, content] of Object.entries(serverModules)) {
  const outPath = join(FACET_DIST, name);
  const dir = outPath.split("/").slice(0, -1).join("/");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, content);
}

// ── Manifest ───────────────────────────────────────────────────────────────
const manifest = {
  builtAt: new Date().toISOString(),
  mainModule: "index.js", // Vite's server entry — exports App directly
  moduleFiles: Object.keys(serverModules),
  assetFiles: clientAssetFiles,
};
writeFileSync(join(FACET_DIST, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`\n=== Facet Build ===`);
console.log(`  Server modules: ${manifest.moduleFiles.length}`);
console.log(`  Client assets: ${clientAssetFiles.length}`);
console.log(`  Main module: ${manifest.mainModule} (exports App directly)`);
