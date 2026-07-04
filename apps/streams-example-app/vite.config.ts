import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";

// wrangler.jsonc is generated (gitignored) — refresh it from envs.ts before
// the cloudflare plugin reads it, so dev and build can never see stale config.
writeWranglerConfig();

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
  // async-proxy "opfs" VFS and deadlock in production builds.)
  optimizeDeps: { exclude: ["@journeyapps/wa-sqlite"] },
  resolve: {
    tsconfigPaths: true,
    alias: {
      "~": fileURLToPath(new URL("../os/src", import.meta.url)),
    },
  },
  plugins: [
    tailwindcss(),
    // The worker (src/worker.ts) runs in workerd during dev; wrangler.jsonc
    // (generated from the root envs.ts) declares its STREAM binding.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact(),
  ],
});
