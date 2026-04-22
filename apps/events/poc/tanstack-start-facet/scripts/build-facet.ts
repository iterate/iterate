/**
 * Post-build script: transforms the Vite build output into the nested-facets
 * manifest format compatible with the Project DO's LOADER system.
 *
 * Run this AFTER `vite build`:
 *   npx vite build && npx tsx scripts/build-facet.ts
 *
 * The Vite build produces:
 *   dist/server/index.js         — server entry (exports { fetch })
 *   dist/server/assets/*.js      — server modules (code-split chunks)
 *   dist/client/assets/*.js      — client bundles (for the browser)
 *
 * This script produces:
 *   facet-dist/manifest.json     — nested-facets manifest
 *   facet-dist/bundle.js         — DO wrapper (mainModule)
 *   facet-dist/*.js              — server modules
 *   facet-dist/assets/*.js       — client assets (served at /assets/*)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const VITE_SERVER = join(ROOT, "dist/server");
const VITE_CLIENT = join(ROOT, "dist/client");
const FACET_DIST = join(ROOT, "facet-dist");

// Clean and recreate output dir
if (existsSync(FACET_DIST)) rmSync(FACET_DIST, { recursive: true });
mkdirSync(join(FACET_DIST, "assets"), { recursive: true });

// ── 1. Collect server modules ──────────────────────────────────────────────

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

// ── 2. Create DO wrapper module ────────────────────────────────────────────

serverModules["bundle.js"] = `
import handler from "./server-entry.js";

export class App {
  #sql;

  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.#sql = state.storage.sql;
    // Ensure things table exists
    this.#sql.exec(\`
      CREATE TABLE IF NOT EXISTS things (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    \`);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── API routes: handled by the DO with SQLite ──
    if (url.pathname === "/api/things" && request.method === "GET") {
      const rows = this.#sql.exec("SELECT id, name, created_at as createdAt FROM things ORDER BY created_at DESC").toArray();
      return Response.json(rows);
    }

    if (url.pathname === "/api/things" && request.method === "POST") {
      const body = await request.json();
      const name = body.name?.trim();
      if (!name) return Response.json({ error: "name required" }, { status: 400 });
      const id = "thing_" + crypto.randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      this.#sql.exec("INSERT INTO things (id, name, created_at) VALUES (?, ?, ?)", id, name, now);
      return Response.json({ id, name, createdAt: now }, { status: 201 });
    }

    const deleteMatch = url.pathname.match(/^\\/api\\/things\\/(.+)$/);
    if (deleteMatch && request.method === "DELETE") {
      const id = deleteMatch[1];
      this.#sql.exec("DELETE FROM things WHERE id = ?", id);
      return Response.json({ ok: true });
    }

    // ── WebSocket upgrade ──
    if (request.headers.get("Upgrade") === "websocket" && url.pathname === "/api/ws") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      server.send(JSON.stringify({ type: "connected", doId: this.state.id?.toString() }));

      // Broadcast count of things on connect
      const count = this.#sql.exec("SELECT COUNT(*) as c FROM things").toArray()[0]?.c ?? 0;
      server.send(JSON.stringify({ type: "sync", thingCount: count }));

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Everything else: TanStack Start SSR ──
    try {
      return await handler.fetch(request);
    } catch (err) {
      console.error("[TanStack Start Facet] SSR error:", err.message, err.stack);
      return new Response("Internal Server Error: " + err.message, { status: 500 });
    }
  }
}
`;

// ── 3. Collect client assets ───────────────────────────────────────────────
// Format: leading-slash filenames without "assets/" prefix.
// Files stored at facet-dist/assets/{filename}.
// The Project DO's serveDistAsset matches: /assets{af} where af = "/{filename}".

const clientAssetFiles: string[] = [];
const clientAssetsDir = join(VITE_CLIENT, "assets");
if (existsSync(clientAssetsDir)) {
  for (const f of readdirSync(clientAssetsDir)) {
    const content = readFileSync(join(clientAssetsDir, f), "utf8");
    writeFileSync(join(FACET_DIST, "assets", f), content);
    clientAssetFiles.push(`/${f}`);
  }
}

// No index.html — TanStack Start SSR generates HTML server-side.
// Page navigations must reach the facet for SSR, not be intercepted.

// ── 4. Write server modules to facet-dist ──────────────────────────────────

for (const [name, content] of Object.entries(serverModules)) {
  const outPath = join(FACET_DIST, name);
  const dir = outPath.split("/").slice(0, -1).join("/");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, content);
}

// ── 5. Write manifest ──────────────────────────────────────────────────────

const manifest = {
  builtAt: new Date().toISOString(),
  mainModule: "bundle.js",
  moduleFiles: Object.keys(serverModules),
  assetFiles: clientAssetFiles,
};

writeFileSync(join(FACET_DIST, "manifest.json"), JSON.stringify(manifest, null, 2));

// ── Summary ────────────────────────────────────────────────────────────────

console.log("\n=== Facet Build Complete ===");
console.log(`  Server modules: ${manifest.moduleFiles.length}`);
manifest.moduleFiles.forEach((f) => {
  const size = serverModules[f].length;
  console.log(`    ${f} (${(size / 1024).toFixed(1)}KB)`);
});
console.log(`  Client assets: ${clientAssetFiles.length}`);
clientAssetFiles.forEach((f) => console.log(`    ${f}`));
console.log(`  Main module: ${manifest.mainModule}`);
console.log(`  Output: ${FACET_DIST}`);
