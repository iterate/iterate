import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import captunVite from "captun/vite";
import { defineConfig, type Plugin } from "vite";
import { writeWranglerConfig } from "./scripts/generate-wrangler-config.ts";

// wrangler.jsonc is generated (gitignored) — refresh it from envs.ts before
// the cloudflare plugin reads it, so dev and build can never see stale config.
writeWranglerConfig();

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

// Container-backed Durable Objects (the sandbox class) pair every container
// with a `proxy-everything` egress sidecar. Upstream defaults to linux/amd64;
// under Rosetta on Apple Silicon its transparent-proxy setsockopt fails, so
// pull the host architecture (the image is multi-arch). Only relevant when
// containers are enabled for local dev (wrangler.jsonc dev.enable_containers).
process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE ??= "cloudflare/proxy-everything:3cb1195";
if (process.arch === "arm64") {
  process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE_PLATFORM ??= "linux/arm64";
}

// Public local URL for the dev server, driven by Doppler. CAPTUN_TUNNEL_NAME
// pins the stable URL name; CAPTUN_GATEWAY + CAPTUN_TOKEN target a self-hosted
// gateway. HTTP and WebSockets both route through Captun, including Vite HMR.
// See docs/dev-environments.md.
const captunGateway = process.env.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com";
const captunName = process.env.CAPTUN_TUNNEL_NAME?.trim();

export default defineConfig({
  // wa-sqlite ships an Emscripten `.mjs` + `.wasm` pair that must stay together.
  // The stream DB worker imports the wasm as a Vite asset URL; pre-bundling the
  // package can break that pairing and surface as sqlite3_open_v2 failures.
  // capnweb is excluded so exactly one module instance exists in the dev graph
  // (its session/export tables and RpcTarget identity break across copies).
  optimizeDeps: {
    exclude: ["@journeyapps/wa-sqlite", "capnweb"],
    include: ["@typescript/vfs", "@valtown/codemirror-ts/worker", "typescript"],
  },
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
    // The worker (src/worker.ts) runs in workerd during dev; wrangler.jsonc
    // (generated from the root envs.ts) declares its bindings, and the keys
    // in its `secrets.required` load straight from process.env — which is
    // why `doppler run -- vite dev` needs no .dev.vars file.
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // The builder sidecar runs in the same local workerd so the BUILDER
      // service binding resolves in dev exactly like deployed. Deploy builds
      // (CLOUDFLARE_ENV set) exclude it: the builder deploys from source via
      // `wrangler deploy --config wrangler.builder.jsonc` (deploy.ts), and a
      // second dist wrangler.json would break findBuiltWranglerConfig.
      auxiliaryWorkers: process.env.CLOUDFLARE_ENV
        ? undefined
        : [{ configPath: "./wrangler.builder.jsonc" }],
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
    devServerDiscoveryFile(),
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
});

/**
 * Publishes this worktree's dev server (pid, port, url) to
 * `.dev-server/dev-server.json` so out-of-process tooling (`pnpm auth:mint`,
 * agent browsers, scripts/dev.ts status) can find it no matter how the
 * server was started — a bare `vite dev` works the same as `pnpm dev`.
 */
function devServerDiscoveryFile(): Plugin {
  const dir = fileURLToPath(new URL("./.dev-server", import.meta.url));
  const file = `${dir}/dev-server.json`;
  return {
    name: "iterate:dev-server-discovery-file",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const address = server.httpServer?.address();
        const actualPort = typeof address === "object" && address ? address.port : port;
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          file,
          JSON.stringify(
            {
              pid: process.pid,
              port: actualPort,
              baseUrl: `http://localhost:${actualPort}`,
              startedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      });
      server.httpServer?.once("close", () => {
        if (existsSync(file)) rmSync(file);
      });
    },
  };
}

function safeRollupChunkFileName(chunkInfo: { name: string }) {
  const sanitizedName = chunkInfo.name.replace(/^\.+/, "").replaceAll(/[^A-Za-z0-9_-]+/g, "-");

  // Rollup lets chunkFileNames be a function:
  // https://rollupjs.org/configuration-options/#output-chunkfilenames
  // OS imports sqlfu bundles from `.generated` directories. Without this
  // sanitizer, Rollup can emit Worker module chunks like `assets/.generated-*`,
  // which Cloudflare rejects as missing modules during script upload.
  return `assets/${sanitizedName || "chunk"}-[hash].js`;
}
