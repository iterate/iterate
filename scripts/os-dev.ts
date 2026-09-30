// ROOT `pnpm dev` (and the specs' local worker, playwright.config.ts): apps/os's dev server
// (apps/os/scripts/dev.ts) on iterate's dev/preview account. A local worker proxies its Artifacts,
// AI and Browser bindings to a real Cloudflare account, which wrangler takes from
// CLOUDFLARE_ACCOUNT_ID. apps/os names no account, so a self-host's local dev uses its own; this is
// where iterate's is set. Arguments pass through: `pnpm dev -- --port 8799`, `pnpm dev status`.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PREVIEW_AND_DEV_ACCOUNT_ID } from "../envs.ts";

const { status } = spawnSync("pnpm", ["--dir", "apps/os", "dev", ...process.argv.slice(2)], {
  cwd: path.resolve(import.meta.dirname, ".."),
  stdio: "inherit",
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: PREVIEW_AND_DEV_ACCOUNT_ID },
});
process.exit(status ?? 1);
