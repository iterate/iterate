import { spawn } from "node:child_process";
import process from "node:process";

const baseUrl = (process.env.ITX_BASE || process.env.APP_CONFIG_BASE_URL || "").trim();
const e2eTests = ["itx.e2e.test.ts", "itx-capability-scope-regression.e2e.test.ts"];

if (!baseUrl) {
  console.error("Set ITX_BASE or APP_CONFIG_BASE_URL to the deployed minimal-itx-v3 worker URL.");
  process.exit(1);
}

if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl)) {
  console.error(`Refusing deployed verification against local URL: ${baseUrl}`);
  process.exit(1);
}

async function run(file: string): Promise<number> {
  const child = spawn("pnpm", ["exec", "vitest", "run", file], {
    env: { ...process.env, ITX_BASE: baseUrl.replace(/\/+$/, "") },
    stdio: "inherit",
  });
  return (await new Promise<number | null>((resolve) => child.on("exit", resolve))) ?? 1;
}

for (const file of e2eTests) {
  const code = await run(file);
  if (code !== 0) process.exit(code);
}
