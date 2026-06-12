import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/tanstack-start";
import captunVite from "captun/vite";
import { defineConfig } from "vite";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

// Public tunnel for the dev server, driven entirely by env vars (Doppler):
// CAPTUN_ENABLED=true gives a random tunnel name on the default gateway;
// CAPTUN_TUNNEL_NAME pins a stable name (implies enabled); CAPTUN_GATEWAY +
// CAPTUN_TOKEN target a self-hosted gateway. Plain HTTP only (webhooks,
// previews, e2e) — HMR and WebSockets stay on the local URL. See
// docs/dev-environments.md.
const captunEnabled =
  ["1", "true", "yes"].includes((process.env.CAPTUN_ENABLED ?? "").trim().toLowerCase()) ||
  !!process.env.CAPTUN_TUNNEL_NAME?.trim();

export default defineConfig({
  // wa-sqlite ships an Emscripten `.mjs` + `.wasm` pair that must stay together.
  // The stream DB worker imports the wasm as a Vite asset URL; pre-bundling the
  // package can break that pairing and surface as sqlite3_open_v2 failures.
  // capnweb is excluded so exactly one module instance exists in the dev graph
  // (its session/export tables and RpcTarget identity break across copies).
  optimizeDeps: { exclude: ["@journeyapps/wa-sqlite", "capnweb"] },
  build: {
    rollupOptions: {
      output: {
        chunkFileNames: safeRollupChunkFileName,
      },
    },
    sourcemap: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    allowedHosts: true,
    // TanStack Router rewrites this generated file during dev; ignoring it here
    // avoids Vite reacting to the generator's own writes.
    watch: {
      ignored: ["**/routeTree.gen.ts"],
    },
  },
  plugins: [
    devtools(), // must be first
    // Temporarily disabled: PostHog source map upload fails in this worktree
    // layout because the CLI cannot determine the current git branch.
    alchemy(),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
    ...(captunEnabled
      ? [
          captunVite({
            gateway: process.env.CAPTUN_GATEWAY?.trim() || undefined,
            name: process.env.CAPTUN_TUNNEL_NAME?.trim() || undefined,
            token: process.env.CAPTUN_TOKEN?.trim() || undefined,
          }),
        ]
      : []),
  ],
});

function safeRollupChunkFileName(chunkInfo: { name: string }) {
  const sanitizedName = chunkInfo.name.replace(/^\.+/, "").replaceAll(/[^A-Za-z0-9_-]+/g, "-");

  // Rollup lets chunkFileNames be a function:
  // https://rollupjs.org/configuration-options/#output-chunkfilenames
  // OS imports sqlfu bundles from `.generated` directories. Without this
  // sanitizer, Rollup can emit Worker module chunks like `assets/.generated-*`,
  // which Cloudflare rejects as missing modules during script upload.
  return `assets/${sanitizedName || "chunk"}-[hash].js`;
}
