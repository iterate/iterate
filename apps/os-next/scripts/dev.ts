// scripts/dev.ts — `pnpm dev`: THE BUILD once (scripts/build.ts — wrangler.jsonc, the generated
// modules), then `wrangler dev` on wrangler.jsonc's top-level block (local dev: `routes: []`,
// localhost vars), which bundles and reloads src/worker.ts itself and serves public/ (the issuer's
// pages) through the assets binding. State lives in .wrangler/state (the catalog is the
// `control-plane` facet's own SQLite, src/control-plane/). Project hosts
// hang under `localhost` (`<project>.localhost:<port>` — Chromium resolves them to loopback) and the
// deployment's configuration is the same two secrets a deployment has, as plain dev values: the
// `APP_CONFIG` object (the password `dev`, the operator bearer) and the key alone. Extra arguments go
// to `wrangler dev`: `pnpm dev -- --port 8788`.
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { build } from "./build.ts";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? args[portIndex + 1] : "8788";

await build();
const dev = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "wrangler.jsonc",
    "--persist-to",
    ".wrangler/state",
    "--var",
    `APP_CONFIG_URLS__OS:http://localhost:${port}`,
    "--var",
    `APP_CONFIG_URLS__INGRESS_ROUTING:${JSON.stringify({ type: "subdomains", hostname: "localhost" })}`,
    "--var",
    `APP_CONFIG:${JSON.stringify({
      // the password `dev`, and the mailed code too (wrangler dev simulates the EMAIL binding: the
      // message lands in a local file), so the sign-in page renders both mechanisms as prd does
      login: { password: "dev", emailCode: { from: "iterate <login@localhost>" } },
      secrets: { adminBearer: "dev-admin-api-secret" },
    })}`,
    "--var",
    "APP_CONFIG_SECRETS__KEY:dev-secrets-key",
    ...args,
  ],
  { cwd: root, stdio: "inherit" },
);
dev.on("exit", (code) => process.exit(code ?? 0));
