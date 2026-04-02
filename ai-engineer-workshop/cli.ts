#!/usr/bin/env node
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizePathPrefix } from "./sdk.ts";

await main();

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      script: { type: "string" },
      "path-prefix": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command] = positionals;
  if (values.help || command == null) {
    await printUsage(values.help ? 0 : 1);
    return;
  }

  if (command !== "run") {
    throw new Error(`Unknown command: ${command}`);
  }

  if (!values.script) {
    await printUsage(1);
    return;
  }

  const pathPrefix = normalizePathPrefix(
    values["path-prefix"] ||
      process.env.WORKSHOP_PATH_PREFIX ||
      `/${execSync("id -un").toString().trim()}`,
  );
  const scriptPath = await resolveScriptPath(values.script);
  const module = await import(pathToFileURL(scriptPath).href);

  if (typeof module.default !== "function") {
    throw new Error(`Script ${values.script} must export a default async function`);
  }

  await module.default(pathPrefix);
}

async function printUsage(exitCode: number) {
  const scripts = await getScripts();
  console.error("Usage: workshop run --script <path> [--path-prefix /jonas]");
  if (scripts.length > 0) {
    console.error("");
    console.error("Discovered scripts:");
    for (const script of scripts) {
      console.error(`  ${script}`);
    }
  }
  process.exitCode = exitCode;
}

async function resolveScriptPath(script: string) {
  const directPath = path.resolve(process.cwd(), script);
  if (await fileExists(directPath)) {
    return directPath;
  }

  const discovered = await getScripts();
  const discoveredPath = discovered.find((candidate: string) => candidate === script);
  if (discoveredPath) {
    return path.resolve(process.cwd(), discoveredPath);
  }

  throw new Error(`Script not found: ${script}`);
}

async function getScripts() {
  const files = new Set<string>();
  for await (const file of fs.glob("**/[0-9][0-9]-*/*.{js,ts}", {
    cwd: process.cwd(),
    exclude: ["dist/**", "node_modules/**", "web/**"],
  })) {
    files.add(file);
  }

  for (const file of ["script.ts", "script.js"]) {
    if (await fileExists(path.resolve(process.cwd(), file))) {
      files.add(file);
    }
  }

  return [...files].sort();
}

async function fileExists(filepath: string) {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}
