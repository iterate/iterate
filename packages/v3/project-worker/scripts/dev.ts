// scripts/dev.ts — `pnpm dev`: the LOCAL worker, built the way a deploy is built, served by this
// package's wrangler. `vite dev` would run the worker in the Cloudflare Vite plugin's own workerd,
// which today is older than the compatibility date (wrangler.jsonc) and refuses it — so: `vite build`
// (vite.config.ts: the console, the SDK bundle, the demo page, dist/server/wrangler.json), the
// directory schema into the persisted local D1 (src/control-plane.sql — IF NOT EXISTS, so every run),
// then `wrangler dev` on a LOCAL COPY of the emitted config — the zone `routes` left out: with routes,
// `wrangler dev` forces the routes' host onto every request's URL (`getInferredHost`, no CLI switch),
// which would make a project host on localhost look like the platform host to src/worker.ts —
// with the local configuration the lanes also use: project hosts under `localhost`
// (`<project>.localhost:<port>` — Chromium resolves them to loopback) and plain dev values for the
// three secrets a deployment keeps in wrangler. Local state persists in .wrangler/state (the
// package's, not dist's — a build wipes dist). Extra arguments go to `wrangler dev`:
// `pnpm dev -- --port 8788`.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const run = (command: string, args: string[]): void => {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("pnpm", ["exec", "vite", "build"]);
const { routes: _zoneRoutes, ...localConfig } = JSON.parse(
  readFileSync(path.join(root, "dist/server/wrangler.json"), "utf8"),
);
writeFileSync(path.join(root, "dist/server/wrangler.dev.json"), JSON.stringify(localConfig));
const config = ["--config", "dist/server/wrangler.dev.json", "--persist-to", ".wrangler/state"];
run("pnpm", [
  "exec",
  "wrangler",
  "d1",
  "execute",
  "control-plane-directory",
  "--local",
  "--file",
  "src/control-plane.sql",
  ...config,
]);
run("pnpm", [
  "exec",
  "wrangler",
  "dev",
  ...config,
  "--var",
  "APP_CONFIG_PROJECT_HOSTNAME_BASE:localhost",
  "--var",
  "APP_CONFIG_PROJECT_TOKEN_SECRET:dev-project-token-secret",
  "--var",
  "APP_CONFIG_SESSION_SECRET:dev-session-secret",
  "--var",
  "APP_CONFIG_ADMIN_API_SECRET:dev-admin-api-secret",
  ...process.argv.slice(2).filter((argument) => argument !== "--"), // pnpm passes its `--` through
]);
