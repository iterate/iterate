import { spawn } from "node:child_process";
import process from "node:process";

const baseUrl = (process.env.ITX_BASE || process.env.APP_CONFIG_BASE_URL || "").trim();

if (!baseUrl) {
  console.error("Set ITX_BASE or APP_CONFIG_BASE_URL to the deployed minimal-itx-v4 worker URL.");
  process.exit(1);
}

if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl)) {
  console.error(`Refusing deployed verification against local URL: ${baseUrl}`);
  process.exit(1);
}

const child = spawn("pnpm", ["e2e"], {
  env: { ...process.env, ITX_BASE_URL: baseUrl.replace(/\/+$/, "") },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
