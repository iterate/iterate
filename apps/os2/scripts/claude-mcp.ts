import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import { os } from "@orpc/server";
import { z } from "zod";

const DEFAULT_BASE_HOST = "iterate2.app";
const SERVER_NAME = "iterate";
const DEFAULT_INITIAL_PROMPT = "describe the MCP tools you have available";

const ClaudeMcpInput = z.object({
  projectSlugOrId: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "Project slug or ID must be hostname-safe")
    .describe("OS2 project slug or ID used in the mcp__<project> hostname"),
  baseHost: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_BASE_HOST)
    .describe("Project hostname base, e.g. iterate2.app"),
  prompt: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_INITIAL_PROMPT)
    .describe("Initial prompt passed to Claude before entering interactive mode"),
});

export const claudeMcpScript = os
  .input(ClaudeMcpInput)
  .meta({
    description:
      "Open Claude Code against one remote OS2 project MCP server using the Doppler admin token",
  })
  .handler(async ({ input, signal }) => {
    const adminToken = requireEnv("APP_CONFIG_ADMIN_API_SECRET");
    const mcpUrl = buildProjectMcpUrl({
      baseHost: input.baseHost,
      projectSlugOrId: input.projectSlugOrId,
    });
    const args = [
      "--mcp-config",
      buildClaudeMcpConfig({
        mcpUrl,
        token: adminToken,
      }),
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
      input.prompt,
    ];

    console.info("[claude-mcp] Starting Claude with remote OS2 MCP server:");
    console.info(`  MCP URL: ${mcpUrl}`);
    console.info(`  MCP server name: ${SERVER_NAME}`);
    console.info("  Auth: Doppler OS2 admin token");
    console.info("");

    const result = await runClaude(args, signal);

    if (result.type === "signal") {
      process.exit(result.exitCode);
    }

    return {
      ok: true as const,
      mcpUrl,
      serverName: SERVER_NAME,
    };
  });

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`claude-mcp requires ${name} in the current environment.`);
  }
  return value;
}

function buildProjectMcpUrl(input: { baseHost: string; projectSlugOrId: string }) {
  const baseHost = normalizeBaseHost(input.baseHost);
  return `https://mcp__${input.projectSlugOrId}.${baseHost}/`;
}

function normalizeBaseHost(value: string) {
  const parsed = new URL(/^https?:\/\//.test(value) ? value : `https://${value}`);

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("--base-host must be a hostname, not a URL with a path/query/hash.");
  }

  return parsed.host;
}

function buildClaudeMcpConfig(input: { mcpUrl: string; token: string }) {
  const config = {
    mcpServers: {
      [SERVER_NAME]: {
        type: "http",
        url: input.mcpUrl,
        headers: {
          Authorization: `Bearer ${input.token}`,
        },
      },
    },
  };

  return JSON.stringify(config);
}

export type ClaudeProcessResult =
  | { type: "exit"; code: number }
  | { type: "signal"; exitCode: number; signal: NodeJS.Signals };

export async function runClaude(
  args: string[],
  signal: AbortSignal | undefined,
): Promise<ClaudeProcessResult> {
  if (signal?.aborted) {
    return { type: "signal", exitCode: signalExitCode("SIGTERM"), signal: "SIGTERM" };
  }

  const result = await runClaudeChild({
    args,
    env: process.env,
    signal,
    spawnChild: (command, childArgs, options) => spawn(command, childArgs, options),
  });

  if (result.type === "signal") {
    return result;
  }

  if (result.code !== 0) {
    throw new Error(`claude exited with code ${result.code}.`);
  }

  return result;
}

export async function runClaudeChild(input: {
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal | undefined;
  spawnChild: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  ) => ChildProcess;
}): Promise<ClaudeProcessResult> {
  const child = input.spawnChild("claude", input.args, {
    env: input.env,
    stdio: "inherit",
  });

  return await new Promise<ClaudeProcessResult>((resolve, reject) => {
    const forwardSignal = (forwardedSignal: NodeJS.Signals) => {
      if (!child.killed) {
        child.kill(forwardedSignal);
      }
    };
    const abortChild = () => forwardSignal("SIGTERM");
    const forwardSIGINT = () => forwardSignal("SIGINT");
    const forwardSIGTERM = () => forwardSignal("SIGTERM");
    const forwardSIGHUP = () => forwardSignal("SIGHUP");
    const cleanup = () => {
      input.signal?.removeEventListener("abort", abortChild);
      process.off("SIGINT", forwardSIGINT);
      process.off("SIGTERM", forwardSIGTERM);
      process.off("SIGHUP", forwardSIGHUP);
    };

    input.signal?.addEventListener("abort", abortChild, { once: true });
    process.on("SIGINT", forwardSIGINT);
    process.on("SIGTERM", forwardSIGTERM);
    process.on("SIGHUP", forwardSIGHUP);

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });

    child.once("close", (code, closedSignal) => {
      cleanup();

      if (closedSignal) {
        resolve({
          type: "signal",
          exitCode: signalExitCode(closedSignal),
          signal: closedSignal,
        });
        return;
      }

      resolve({ type: "exit", code: code ?? 1 });
    });
  });
}

export function signalExitCode(signal: NodeJS.Signals) {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    case "SIGHUP":
      return 129;
    default:
      return 1;
  }
}
