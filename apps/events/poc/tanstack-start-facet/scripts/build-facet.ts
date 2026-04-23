/**
 * Post-build: transform Vite output into nested-facets LOADER format.
 *
 * Run AFTER `vite build`:
 *   npx vite build && npx tsx scripts/build-facet.ts
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

// ── Server modules ─────────────────────────────────────────────────────────
const serverModules: Record<string, string> = {};

serverModules["server-entry.js"] = readFileSync(join(VITE_SERVER, "index.js"), "utf8");

const serverAssetsDir = join(VITE_SERVER, "assets");
if (existsSync(serverAssetsDir)) {
  for (const f of readdirSync(serverAssetsDir)) {
    if (f.endsWith(".js")) {
      serverModules[`assets/${f}`] = readFileSync(join(serverAssetsDir, f), "utf8");
    }
  }
}

// ── DO wrapper ─────────────────────────────────────────────────────────────
// Thin wrapper: delegates everything to TanStack Start's handler.
// Route.server.handlers works with Vite 8 + @cloudflare/vite-plugin 1.33+,
// so oRPC is handled by TanStack Start routes, not the DO wrapper.
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
      console.error("[Facet] error:", err.message, err.stack);
      return new Response("Error: " + err.message, { status: 500 });
    }
  }
}
`;

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
  mainModule: "bundle.js",
  moduleFiles: Object.keys(serverModules),
  assetFiles: clientAssetFiles,
};
writeFileSync(join(FACET_DIST, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`\n=== Facet Build ===`);
console.log(`  Server modules: ${manifest.moduleFiles.length}`);
console.log(`  Client assets: ${clientAssetFiles.length}`);
console.log(`  Main module: ${manifest.mainModule}`);
