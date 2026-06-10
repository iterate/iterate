import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { os } from "@orpc/server";
import { z } from "zod";

import { claudeMcpScript } from "./claude-mcp.ts";
import { seedIterateConfigBaseRepoScript } from "./seed-iterate-config-base-repo.ts";

const DEFAULT_APP_CONFIG_BASE_URL = "https://os.iterate.com";

const StreamTuiInput = z.object({
  projectSlugOrId: z.string().trim().min(1).describe("OS project slug or ID"),
  streamPath: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Project stream path, e.g. /agents/demo. Omit to start in stream tree view."),
  osBaseUrl: z
    .string()
    .trim()
    .url()
    .default(process.env.APP_CONFIG_BASE_URL || DEFAULT_APP_CONFIG_BASE_URL)
    .describe("OS base URL"),
});

export const router = os.router({
  artifacts: {
    "seed-config-base": seedIterateConfigBaseRepoScript,
  },
  "claude-mcp": claudeMcpScript,
  "stream-tui": os
    .input(StreamTuiInput)
    .meta({
      description: "Open an OpenTUI project stream viewer",
    })
    .handler(async ({ input }) => {
      const streamPathArgs = input.streamPath ? ["--stream-path", input.streamPath] : [];
      // OpenTUI is currently Bun-only: https://opentui.com/docs/getting-started/
      await runInheritedProcess("bun", [
        resolveStreamTuiEntrypointPath(),
        "--base-url",
        input.osBaseUrl,
        "--project-slug-or-id",
        input.projectSlugOrId,
        ...streamPathArgs,
      ]);
    }),
});

function resolveStreamTuiEntrypointPath() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "../stream-tui/event-stream-terminal.tsx"),
    join(moduleDir, "../stream-tui/event-stream-terminal.mjs"),
    join(moduleDir, "../stream-tui/event-stream-terminal.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("Could not find the Iterate stream TUI entrypoint.");
}

async function runInheritedProcess(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode ?? "unknown"}.`);
  }
}
