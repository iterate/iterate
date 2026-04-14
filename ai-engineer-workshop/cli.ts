#!/usr/bin/env node
import { execSync } from "node:child_process";

import {
  getDeployCommandHelp,
  parseDeployCommandArgs,
  promptForDeployCommandInput,
  runDeployCommand,
} from "./lib/deploy-command.ts";

process.env.PATH_PREFIX = normalizePathPrefix(
  process.env.PATH_PREFIX || `/${execSync("id -un").toString().trim()}`,
);

const userArgs = process.argv.slice(2);
if (userArgs.length === 0 || userArgs[0] === "-h" || userArgs[0] === "--help") {
  console.log(getCliHelp());
  process.exit(0);
}

if (userArgs[0] !== "deploy") {
  console.error(`Unknown command: ${userArgs[0]}`);
  console.log(getCliHelp());
  process.exit(1);
}

await runBuiltinDeploy(userArgs.slice(1));

async function runBuiltinDeploy(args: string[]) {
  const { help, input } = parseDeployCommandArgs(args);
  if (help) {
    console.log(getCliHelp());
    return;
  }

  const commandInput = await promptForDeployCommandInput(input);
  const result = await runDeployCommand(commandInput);

  console.info(
    `Deployed ${result.file} (${result.processorExportName}) to ${result.streamPath} as ${result.processorSlug}`,
  );
  console.log(JSON.stringify(result, null, 2));
}

function getCliHelp() {
  return [
    "Usage: ai-engineer-workshop deploy [options]",
    "",
    "This CLI only supports the deploy command.",
    "",
    getDeployCommandHelp(),
  ].join("\n");
}

function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}
