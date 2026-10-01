// ROOT `pnpm dev` (and the specs' local worker, test/playwright.config.ts): core/os's dev server
// (core/os/scripts/dev.ts) on iterate's dev/preview account, offering iterate's project templates.
// A local worker proxies its Artifacts, AI and Browser bindings to a real Cloudflare account, which
// wrangler takes from CLOUDFLARE_ACCOUNT_ID. core/os names no account, so a self-host's local dev
// uses its own; this is where iterate's is set. Arguments pass through: `pnpm dev -- --port 8799`,
// `pnpm dev status`.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { formatConfigRepoTemplateReference } from "iterate/config-repo-template";
import { githubHeadOf } from "../core/os/scripts/build.ts";
import { PREVIEW_AND_DEV_ACCOUNT_ID } from "../envs.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
// the commands that start a server build it: they get configs/* as this checkout has them (build.ts
// `--template-root`; core's own come with every build), a local creation's voice pinned to main's
// newest build as it seeds
const serves = !args[0] || args[0].startsWith("-") || ["start", "restart"].includes(args[0]);
const head = githubHeadOf(repoRoot);
const templates = serves
  ? readdirSync(path.join(repoRoot, "configs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        "--template",
        formatConfigRepoTemplateReference({ ...head, path: `configs/${entry.name}` }),
      ])
  : [];

const { status } = spawnSync(
  "pnpm",
  [
    "--dir",
    "core/os",
    "dev",
    ...args,
    ...(templates.length ? ["--template-root", repoRoot, ...templates] : []),
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: PREVIEW_AND_DEV_ACCOUNT_ID },
  },
);
process.exit(status ?? 1);
