import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createCli } from "trpc-cli";
import * as prompts from "@clack/prompts";
import { testingRouter } from "../../backend/trpc/routers/testing.ts";
import { t } from "./config.ts";
import { estate } from "./commands/checkout-estate.ts";
import { gh } from "./commands/gh-commands.ts";
import { dev } from "./commands/dev.ts";
import { db } from "./cli-db.ts";

// Normalize forwarded args when invoked via pnpm recursion.
// pnpm adds a standalone "--" before forwarded args, which stops option parsing.
// Remove it so flags like "-c" are recognized by the CLI.
const dashdashIndex = process.argv.indexOf("--");
if (dashdashIndex !== -1) {
  process.argv.splice(dashdashIndex, 1);
}

const router = t.router({
  estate,
  gh,
  dev,
  testing: testingRouter,
});

if (process.argv.length === 2) {
  console.error("No command provided, assuming you want to run `iterate` sdk cli");
  // Run the cli.js script from packages/sdk
  const cliPath = resolve(import.meta.dirname, "../../../../packages/sdk/cli.js");
  const result = spawnSync("node", [cliPath], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  process.exit(result.status ?? 0);
}

const cli = createCli({ router, context: { db } });
cli.run({ prompts });
