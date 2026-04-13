#!/usr/bin/env node
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import * as prompts from "@clack/prompts";
import { os } from "@orpc/server";
import { createCli, type AnyRouter, yamlTableConsoleLogger } from "trpc-cli";

import { normalizePathPrefix } from "./sdk.ts";

process.env.PATH_PREFIX = normalizePathPrefix(
  process.env.PATH_PREFIX || `/${execSync("id -un").toString().trim()}`,
);

const { router, leafPaths } = await discoverRouter();

const userArgs = process.argv.slice(2);
const needsInteractiveSelection =
  userArgs.length === 0 || (userArgs.length === 1 && userArgs[0] === "run");

let argv: string[] | undefined;
if (needsInteractiveSelection && leafPaths.length > 0) {
  const selected = await prompts.select({
    message: "Select a script to run",
    options: leafPaths.sort().map((p) => ({ value: p, label: p })),
  });
  if (prompts.isCancel(selected)) process.exit(0);
  argv = (selected as string).split("/");
}

await createCli({ router: router as AnyRouter }).run({
  prompts,
  logger: yamlTableConsoleLogger,
  ...(argv && { argv }),
});

async function discoverRouter() {
  const tree: Record<string, unknown> = {};
  const leafPaths: string[] = [];

  for await (const file of fs.glob("**/*.{js,ts}", {
    cwd: process.cwd(),
    exclude: [
      "dist/**",
      "node_modules/**",
      "web/**",
      "e2e/**",
      "lib/**",
      "video/**",
      "old-stuff/**",
      "clean copy/**",
      "deployed-processor/**",
    ],
  })) {
    if (!isCandidateScript(file)) continue;

    try {
      const mod = await import(pathToFileURL(path.resolve(process.cwd(), file)).href);
      const procedure = mod.handler ?? mod.default;
      if (!procedure?.["~orpc"]) continue;

      const segments = fileToSegments(file);
      leafPaths.push(segments.join("/"));

      let node = tree;
      for (let i = 0; i < segments.length - 1; i++) {
        node[segments[i]] ??= {};
        node = node[segments[i]] as Record<string, unknown>;
      }
      node[segments.at(-1)!] = procedure;
    } catch {
      // skip files that fail to import
    }
  }

  return {
    router: os.router(toNestedRouter(tree) as never) as AnyRouter,
    leafPaths,
  };
}

function fileToSegments(file: string): string[] {
  return file.replace(/\.(ts|js)$/, "").split("/");
}

function toNestedRouter(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (value != null && typeof value === "object" && "~orpc" in value) {
      out[key] = value;
    } else if (value != null && typeof value === "object") {
      out[key] = os.router(toNestedRouter(value as Record<string, unknown>) as never);
    }
  }
  return out;
}

function isCandidateScript(file: string) {
  const basename = path.basename(file);
  return (
    !file.includes("/.") &&
    !file.endsWith(".d.ts") &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".e2e.test.ts") &&
    !file.endsWith("-types.ts") &&
    ![
      "agent.ts",
      "codemode.ts",
      "prompt.ts",
      "slack-input.ts",
      "cli.ts",
      "sdk.ts",
      "test-helpers.ts",
      "contract.ts",
    ].includes(basename)
  );
}
