import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import { os } from "@orpc/server";
import { z } from "zod";

const DEFAULT_MCP_BASE_URL = "https://mcp.iterate.com";
const LOCAL_DEVELOPMENT_MCP_PATH = "/api/mcp";
const SERVER_NAME = "iterate";
const DEFAULT_INITIAL_PROMPT = "describe the MCP tools you have available";

const ClaudeMcpInput = z.object({
  projectSlugOrId: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "Project slug or ID must be hostname-safe")
    .optional()
    .describe("Deprecated; admin-token MCP access now exposes all projects."),
  baseHost: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("MCP base hostname or URL, e.g. mcp.iterate.com or mcp.example.com/iterate."),
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
      "Print the Claude Code command for the remote OS MCP server (after Doppler admin-token preflight)",
  })
  .handler(async ({ input }) => {
    const adminToken = requireEnv("APP_CONFIG_ADMIN_API_SECRET");
    const mcpUrl = input.baseHost ? normalizeBaseUrl(input.baseHost) : defaultMcpUrlFromEnv();
    await assertMcpAdminBearerAccepted({ mcpUrl, token: adminToken });
    const command = buildClaudeShellCommand([
      "--mcp-config",
      buildClaudeMcpConfig({
        mcpUrl,
        token: adminToken,
      }),
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
      input.prompt,
    ]);

    console.info(
      [
        "Here's the command you should run. It's an interactive TUI application so you may want to run it in tmux:",
        "",
        command,
      ].join("\n"),
    );
  });

export function defaultMcpUrlFromEnv() {
  const resolvedMcpBaseUrl = resolveMcpBaseUrl({
    appBaseUrl: process.env.APP_CONFIG_BASE_URL,
    mcpBaseUrl: process.env.APP_CONFIG_MCP__BASE_URL,
  });
  if (resolvedMcpBaseUrl) return resolvedMcpBaseUrl;

  return normalizeBaseUrl(DEFAULT_MCP_BASE_URL);
}

function resolveMcpBaseUrl(input: {
  appBaseUrl?: string;
  mcpBaseUrl?: string;
  requestUrl?: string;
}) {
  const explicitMcpBaseUrl = input.mcpBaseUrl?.trim();
  if (explicitMcpBaseUrl) return normalizeBaseUrl(explicitMcpBaseUrl);

  const localBaseUrl = input.appBaseUrl?.trim() || input.requestUrl?.trim();
  if (!localBaseUrl) return null;

  const parsed = new URL(localBaseUrl);
  if (!isLocalhostHostname(parsed.hostname)) return null;

  return normalizeBaseUrl(new URL(LOCAL_DEVELOPMENT_MCP_PATH, parsed.origin).toString());
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`claude-mcp requires ${name} in the current environment.`);
  }
  return value;
}

function normalizeBaseUrl(value: string) {
  const parsed = new URL(/^https?:\/\//.test(value) ? value : `https://${value}`);

  if (parsed.search || parsed.hash) {
    throw new Error("--base-host must not include a query or hash.");
  }

  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function isLocalhostHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export async function assertMcpAdminBearerAccepted(input: { mcpUrl: string; token: string }) {
  const response = await fetch(input.mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "claude-mcp-preflight", version: "0" },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 401) {
    const dopplerConfig = process.env.DOPPLER_CONFIG?.trim();
    throw new Error(
      [
        "MCP bearer token was rejected (401).",
        "APP_CONFIG_ADMIN_API_SECRET must match the OS deployment serving this MCP URL.",
        dopplerConfig
          ? `Current Doppler config: ${dopplerConfig}`
          : "No DOPPLER_CONFIG in env — `pnpm cli` defaults to os/prd; override with e.g. `doppler run --project os --config preview_2 -- pnpm cli …`.",
        `MCP URL: ${input.mcpUrl}`,
      ].join("\n"),
    );
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(
      `MCP preflight failed (${response.status}) for ${input.mcpUrl}: ${body || response.statusText}`,
    );
  }
}

export function buildClaudeShellCommand(args: string[]) {
  return ["claude", ...args].map(shellQuoteArg).join(" ");
}

function shellQuoteArg(arg: string) {
  if (/^[\w./:@%+=,-]+$/.test(arg)) {
    return arg;
  }

  return `'${arg.replace(/'/g, `'\\''`)}'`;
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
