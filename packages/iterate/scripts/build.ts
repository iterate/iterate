import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { checkClientBundles, checkPhysicalWorkerBundles } from "./check-bundles.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = fileURLToPath(new URL("../dist", import.meta.url));

export default async function build(): Promise<void> {
  await rm(distRoot, { force: true, recursive: true });

  await runPhase("build browser clients", [
    "exec",
    "tsdown",
    "--config",
    "tsdown.app-clients.config.ts",
  ]);
  await checkClientBundles();

  await runPhase("build package and physical workers", ["exec", "tsdown"]);
  await checkPhysicalWorkerBundles();

  await runPhase("emit declarations", ["exec", "tsc", "-p", "tsconfig.sdk.json"]);
}

async function runPhase(name: string, args: string[]): Promise<void> {
  console.log(`\n[iterate build] ${name}`);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn("pnpm", args, { cwd: packageRoot, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  if (result.signal !== null) {
    throw new Error(`pnpm ${args.join(" ")} terminated by ${result.signal}`);
  }
  if (result.code !== 0) {
    throw new Error(`pnpm ${args.join(" ")} exited with code ${result.code}`);
  }
}

void createCli({ ...import.meta, name: "build" }).run();
