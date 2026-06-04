import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Miniflare / Vite sometimes fetch JSON endpoints that return gzip without
// Content-Encoding; undici's response.json() then kills the dev process.
const require = createRequire(import.meta.url);
const { Response } = await import(require.resolve("undici"));
const responseJson = Response.prototype.json;
Response.prototype.json = async function (...args) {
  const body = Buffer.from(await this.clone().arrayBuffer());
  if (body[0] === 0x1f && body[1] === 0x8b) {
    return JSON.parse(gunzipSync(body).toString("utf8"));
  }
  return responseJson.apply(this, args);
};

export default defineConfig({
  // wa-sqlite ships an Emscripten `.mjs` + `.wasm` pair that must NOT go through esbuild's
  // dep pre-bundling, or the glue/wasm pairing breaks. Exclude it; the dedicated worker
  // (stream-db.worker.ts) loads the `.wasm` as a hashed asset via a `?url` import, which
  // Vite resolves correctly in dev and in the production/Cloudflare build alike.
  //
  // Note there is deliberately NO COOP/COEP here: OPFSCoopSyncVFS needs no cross-origin
  // isolation. (Enabling it is what made @sqlite.org/sqlite-wasm auto-install its
  // async-proxy "opfs" VFS and deadlock in production builds — see log.md.)
  optimizeDeps: { exclude: ["@journeyapps/wa-sqlite"] },
  plugins: [
    tailwindcss(),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      inspectorPort: false,
    }),
    tanstackStart(),
    viteReact(),
  ],
});
