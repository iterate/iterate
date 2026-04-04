#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "../src/apps/cli.ts");

const child = spawn(process.execPath, [tsxCliPath, sourcePath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
