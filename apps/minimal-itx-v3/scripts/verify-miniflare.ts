import { spawn } from "node:child_process";
import process from "node:process";
import { DEFAULT_ITX_BASE_URL } from "../src/client.ts";

const baseUrl = DEFAULT_ITX_BASE_URL;
const typeTests = [
  "types-and-schemas.type.test.ts",
  "types-and-schemas.wrangler-proof.type.test.ts",
];
const e2eTests = ["itx.e2e.test.ts", "itx-capability-scope-regression.e2e.test.ts"];

async function run(command: string, args: string[], env = process.env): Promise<number> {
  const child = spawn(command, args, { env, stdio: "inherit" });
  return (await new Promise<number | null>((resolve) => child.on("exit", resolve))) ?? 1;
}

async function startDev() {
  const dev = spawn("pnpm", ["dev"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let settled = false;
  const ready = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      output += text;
      if (text.includes("Ready on") && !settled) {
        settled = true;
        resolve();
      }
    };
    dev.stdout.on("data", onData);
    dev.stderr.on("data", onData);
    dev.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`wrangler dev exited before ready (${code ?? "unknown"}):\n${output}`));
      }
    });
  });

  await ready;
  return dev;
}

async function stopDev(dev: ReturnType<typeof spawn>) {
  if (dev.exitCode !== null) return;
  dev.kill("SIGTERM");
  await new Promise<void>((resolve) => dev.on("exit", () => resolve()));
}

const typeCode = await run("pnpm", ["exec", "vitest", "run", ...typeTests]);
if (typeCode !== 0) process.exit(typeCode);

for (const file of e2eTests) {
  const dev = await startDev();
  try {
    const code = await run("pnpm", ["exec", "vitest", "run", file], {
      ...process.env,
      ITX_BASE: baseUrl,
    });
    if (code !== 0) process.exitCode = code;
  } finally {
    await stopDev(dev);
  }
  if (process.exitCode) break;
}
