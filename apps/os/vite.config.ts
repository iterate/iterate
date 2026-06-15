import { existsSync, readFileSync } from "node:fs";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/tanstack-start";
import captunVite from "captun/vite";
import { defineConfig } from "vite";

// Local dev runs the whole worker topology (docs/worker-topology.md) inside
// vite's single workerd: alchemy.run.ts writes one wrangler config per
// worker plus this manifest before spawning vite. One workerd keeps
// cross-script Durable Object names intact (the cross-process dev registry
// proxy loses ctx.id.name). Absent manifest (plain `vite build`, CI) → no
// auxiliary workers.
const auxWorkersManifest = new URL("./.alchemy/local/aux-workers.json", import.meta.url);
function readAuxiliaryWorkers(command: string) {
  // Dev server only: a production `vite build` must not pick up the dev
  // manifest a previous `pnpm dev` left in this worktree — deployed workers
  // are built by alchemy from their entrypoints, not by vite.
  if (command !== "serve" || !existsSync(auxWorkersManifest)) return [];
  return (JSON.parse(readFileSync(auxWorkersManifest, "utf8")) as string[]).map((configPath) => ({
    configPath,
  }));
}

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

// Public tunnel for the dev server, driven by Doppler. CAPTUN_TUNNEL_NAME pins the
// stable tunnel name; CAPTUN_GATEWAY + CAPTUN_TOKEN target a self-hosted
// gateway. Plain HTTP only (webhooks, previews, e2e) — HMR and WebSockets stay
// on the local URL. See docs/dev-environments.md.
const captunGateway = process.env.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com";
const captunName = process.env.CAPTUN_TUNNEL_NAME?.trim();

export default defineConfig(({ command }) => ({
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
    alchemy({ auxiliaryWorkers: readAuxiliaryWorkers(command) }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
    ...(captunName
      ? [
          captunVite({
            gateway: captunGateway,
            name: captunName,
            token: process.env.CAPTUN_TOKEN?.trim() || undefined,
          }),
        ]
      : []),
  ],
}));

function safeRollupChunkFileName(chunkInfo: { name: string }) {
  const sanitizedName = chunkInfo.name.replace(/^\.+/, "").replaceAll(/[^A-Za-z0-9_-]+/g, "-");

  // Rollup lets chunkFileNames be a function:
  // https://rollupjs.org/configuration-options/#output-chunkfilenames
  // OS imports sqlfu bundles from `.generated` directories. Without this
  // sanitizer, Rollup can emit Worker module chunks like `assets/.generated-*`,
  // which Cloudflare rejects as missing modules during script upload.
  return `assets/${sanitizedName || "chunk"}-[hash].js`;
}
