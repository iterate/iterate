import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { defineConfig } from "vite";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

export default defineConfig({
  // wa-sqlite ships an Emscripten `.mjs` + `.wasm` pair that must stay together.
  // The stream DB worker imports the wasm as a Vite asset URL; pre-bundling the
  // package can break that pairing and surface as sqlite3_open_v2 failures.
  optimizeDeps: { exclude: ["@journeyapps/wa-sqlite"] },
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
