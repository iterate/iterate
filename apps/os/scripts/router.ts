import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { os } from "@orpc/server";
import { z } from "zod";

import { claudeMcpScript } from "./claude-mcp.ts";

const DEFAULT_OS_BASE_URL = "https://os.iterate.com";
const scriptsDir = dirname(fileURLToPath(import.meta.url));

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
    .default(process.env.OS_BASE_URL || DEFAULT_OS_BASE_URL)
    .describe("OS base URL"),
});

export const router = os.router({
  "claude-mcp": claudeMcpScript,
  "stream-tui": os
    .input(StreamTuiInput)
    .meta({
      description: "Open an OpenTUI project stream viewer",
    })
    .handler(async ({ input }) => {
      const scriptPath = join(scriptsDir, "event-stream-terminal.tsx");
      const streamPathArgs = input.streamPath ? ["--stream-path", input.streamPath] : [];
      // OpenTUI is currently Bun-only: https://opentui.com/docs/getting-started/
      await runInheritedProcess("bun", [
        scriptPath,
        "--base-url",
        input.osBaseUrl,
        "--project-slug-or-id",
        input.projectSlugOrId,
        ...streamPathArgs,
      ]);

      return { ok: true as const };
    }),
});

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
