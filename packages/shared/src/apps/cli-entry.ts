import process from "node:process";

import { FailedToExitError } from "trpc-cli";

import { runAppCli } from "./cli.ts";

try {
  await runAppCli();
} catch (error) {
  if (error instanceof FailedToExitError) {
    process.exitCode = error.exitCode;
    process.exit(process.exitCode);
  }

  console.error(error);
  process.exit(process.exitCode ?? 1);
}
