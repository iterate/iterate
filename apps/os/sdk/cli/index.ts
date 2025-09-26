import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import * as prompts from "@clack/prompts";
import { t } from "./config.ts";
import { estate } from "./commands/checkout-estate.ts";
import { gh } from "./commands/gh-commands.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = t.router({
  estate,
  gh,
});

if (process.argv.length === 2) {
  console.error("No command provided, assuming you want to run `iterate` sdk cli");
  // Run the cli.js script from packages/sdk
  const cliPath = resolve(__dirname, "../../../../packages/sdk/cli.js");
  const result = spawnSync("node", [cliPath], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  process.exit(result.status ?? 0);
}

const cli = createCli({ router });
if (process.argv) cli.run({ prompts });
