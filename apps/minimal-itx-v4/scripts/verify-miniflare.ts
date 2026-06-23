import { spawn } from "node:child_process";
import process from "node:process";
import { DEFAULT_ITX_BASE_URL } from "../src/client.ts";

const baseUrl = DEFAULT_ITX_BASE_URL;
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

try {
  await ready;
  const e2e = spawn("pnpm", ["e2e"], {
    env: { ...process.env, ITX_BASE: baseUrl, ITX_BASE_URL: baseUrl },
    stdio: "inherit",
  });
  const code = await new Promise<number | null>((resolve) => e2e.on("exit", resolve));
  process.exitCode = code ?? 1;
} finally {
  dev.kill("SIGTERM");
}
