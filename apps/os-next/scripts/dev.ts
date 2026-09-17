// scripts/dev.ts — `pnpm dev`: THE BUILD once (scripts/build.ts — wrangler.jsonc, the generated
// modules), then `wrangler dev` on wrangler.jsonc's top-level block (local dev: `routes: []`,
// localhost vars), which bundles and reloads src/worker.ts itself — the issuer's pages included, they
// are HTML the worker renders. The directory schema goes into the
// persisted local D1 first (src/control-plane.sql — IF NOT EXISTS, so every run); state lives in
// .wrangler/state. Project hosts hang under `localhost` (`<project>.localhost:<port>` — Chromium
// resolves them to loopback) and the deployment's secrets are plain dev values. Extra arguments go to
// `wrangler dev`: `pnpm dev -- --port 8788`.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { build } from "./build.ts";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? args[portIndex + 1] : "8788";
const config = ["--config", "wrangler.jsonc", "--persist-to", ".wrangler/state"];

await build();
const schema = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "control-plane-directory",
    "--local",
    "--file",
    "src/control-plane.sql",
    ...config,
  ],
  { cwd: root, stdio: "inherit" },
);
if (schema.status !== 0) process.exit(schema.status ?? 1);
const dev = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    ...config,
    "--var",
    "APP_CONFIG_PROJECT_HOSTNAME_BASE:localhost",
    "--var",
    `APP_CONFIG_PLATFORM_ORIGIN:http://localhost:${port}`,
    "--var",
    "APP_CONFIG_MCP_ORIGIN:",
    "--var",
    "APP_CONFIG_SESSION_SECRET:dev-session-secret",
    "--var",
    "APP_CONFIG_SECRETS_KEY:dev-secrets-key",
    "--var",
    "APP_CONFIG_ADMIN_API_SECRET:dev-admin-api-secret",
    ...args,
  ],
  { cwd: root, stdio: "inherit" },
);
dev.on("exit", (code) => process.exit(code ?? 0));
