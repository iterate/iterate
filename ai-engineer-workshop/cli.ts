#!/usr/bin/env node
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import * as prompts from "@clack/prompts";
import { os } from "@orpc/server";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod";

import { normalizePathPrefix } from "./sdk.ts";

process.env.PATH_PREFIX = normalizePathPrefix(
  process.env.PATH_PREFIX || `/${execSync("id -un").toString().trim()}`,
);

const modules = await discoverRunnableModules();
const scriptNames = [...modules.keys()].sort();
const scriptSchema =
  scriptNames.length > 0 ? z.enum(scriptNames as [string, ...string[]]) : z.string();

const router = os.router({
  run: os
    .input(
      z.object({
        script: scriptSchema.describe("workshop script to run"),
        pathPrefix: z
          .string()
          .default(process.env.PATH_PREFIX)
          .describe("stream path prefix, e.g. /jonas"),
      }),
    )
    .handler(async ({ input }) => {
      process.env.PATH_PREFIX = normalizePathPrefix(input.pathPrefix);

      const module = modules.get(input.script);
      if (!module) {
        throw new Error(`Script ${input.script} not found`);
      }

      await module.run();
    }),
});

await createCli({ router }).run({ prompts, logger: yamlTableConsoleLogger });

async function discoverRunnableModules() {
  const result = new Map<string, { run: () => Promise<unknown> }>();

  for await (const file of fs.glob("examples/**/*.{js,ts}", {
    cwd: process.cwd(),
    exclude: ["dist/**", "node_modules/**", "web/**", "e2e/**", "lib/**"],
  })) {
    if (!isCandidateScript(file)) continue;
    await tryRegister(result, file);
  }

  for (const file of ["script.ts", "script.js"]) {
    if (await fileExists(path.join(process.cwd(), file))) {
      await tryRegister(result, file);
    }
  }

  return result;
}

async function tryRegister(map: Map<string, { run: () => Promise<unknown> }>, file: string) {
  const module = await import(pathToFileURL(path.resolve(process.cwd(), file)).href);
  if (typeof module.run === "function") {
    map.set(file, module as { run: () => Promise<unknown> });
  }
}

function isCandidateScript(file: string) {
  const basename = path.basename(file);

  return (
    !file.includes("/.") &&
    !file.endsWith(".d.ts") &&
    !file.endsWith(".test.ts") &&
    !file.endsWith("-types.ts") &&
    !["agent.ts", "codemode.ts", "prompt.ts", "slack-input.ts"].includes(basename)
  );
}

async function fileExists(filepath: string) {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}
