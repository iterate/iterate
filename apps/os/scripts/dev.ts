import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { build } from "./build.ts";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? args[portIndex + 1] : "8788";

await build();
const dev = spawn("pnpm", ["exec", "vite", "dev", ...args], {
  cwd: root,
  env: { ...process.env, CLOUDFLARE_ENV: "", OS_NEXT_ENV: "", OS_NEXT_DEV_PORT: port },
  stdio: "inherit",
});
dev.on("exit", (code) => process.exit(code ?? 0));
