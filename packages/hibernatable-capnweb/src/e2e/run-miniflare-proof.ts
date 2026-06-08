import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import getPort from "get-port";

const port = await getPort({ port: 8976 });
const baseUrl = `http://127.0.0.1:${port}`;
const wrangler = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "./src/e2e/wrangler.proof.jsonc",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const wranglerExit = once(wrangler, "exit").catch(() => undefined);

let output = "";
wrangler.stdout.setEncoding("utf8");
wrangler.stderr.setEncoding("utf8");
wrangler.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
wrangler.stderr.on("data", (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});

try {
  await waitForReady();
  const proof = spawn("pnpm", ["tsx", "./src/e2e/prove.ts", baseUrl], {
    cwd: new URL("../../", import.meta.url),
    env: {
      ...process.env,
      HIBERNATABLE_CAPNWEB_PROOF_BASE_URL: baseUrl,
    },
    stdio: "inherit",
  });
  const [code] = (await once(proof, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`proof failed with exit code ${code}`);
} finally {
  wrangler.kill("SIGINT");
  await wranglerExit;
}

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/__proof/status`);
      if (response.ok) return;
    } catch {}
    if (output.includes("Failed") || output.includes("Error:")) {
      throw new Error(`wrangler failed before becoming ready:\n${output}`);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for wrangler dev:\n${output}`);
}
