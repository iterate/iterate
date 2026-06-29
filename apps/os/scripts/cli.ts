import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";

export * as artifacts from "./artifacts.ts";
export * as dev from "./dev.ts";
export * as itx from "./itx.ts";

const DEFAULT_MCP_BASE_URL = "https://mcp.iterate.com";
const LOCAL_DEVELOPMENT_MCP_PATH = "/api/mcp";
const SERVER_NAME = "iterate";
const DEFAULT_INITIAL_PROMPT = "describe the MCP tools you have available";

type ClaudeMcpOptions = {
  /** Deprecated; admin-token MCP access now exposes all projects. */
  projectSlugOrId?: string;
  /** MCP base hostname or URL, e.g. mcp.iterate.com or mcp.example.com/iterate. */
  baseHost?: string;
  /** Initial prompt passed to Claude before entering interactive mode. */
  prompt?: string;
};

/** Print the Claude Code command for the remote OS MCP server after an admin-token preflight. */
export async function claudeMcp(options: ClaudeMcpOptions = {}) {
  const projectSlugOrId = options.projectSlugOrId?.trim();
  if (projectSlugOrId && !/^[a-zA-Z0-9_-]+$/.test(projectSlugOrId)) {
    throw new Error("Project slug or ID must be hostname-safe.");
  }
  const baseHost = options.baseHost?.trim();
  const prompt = options.prompt?.trim() || DEFAULT_INITIAL_PROMPT;
  const adminToken = requireEnv("APP_CONFIG_ADMIN_API_SECRET");
  const mcpUrl = baseHost ? normalizeBaseUrl(baseHost) : defaultMcpUrlFromEnv();
  await assertMcpAdminBearerAccepted({ mcpUrl, token: adminToken });
  const command = [
    "claude",
    "--mcp-config",
    buildClaudeMcpConfig({ mcpUrl, token: adminToken }),
    "--strict-mcp-config",
    "--dangerously-skip-permissions",
    prompt,
  ]
    .map(shellQuoteArg)
    .join(" ");

  console.info(
    [
      "Here's the command you should run. It's an interactive TUI application so you may want to run it in tmux:",
      "",
      command,
    ].join("\n"),
  );
}

if (isMainModule()) {
  const args = process.argv.slice(2);

  /**
   * `pnpm cli` should mean "run the OS CLI for the current Doppler environment".
   *
   * If the caller is already inside `doppler run`, preserve that exact config:
   *
   * If not, enter Doppler without naming a project or config. Doppler then uses
   * the user's local `doppler setup` for `apps/os`, normally `dev_<user>`.
   */
  if (!process.env.DOPPLER_CONFIG) {
    spawnAndExit("doppler", ["run", "--", "tsx", fileURLToPath(import.meta.url), ...args]);
  }

  void createCli({
    ...import.meta,
    name: "@iterate-com/os",
    jsonInput: "auto",
  }).run({
    argv: args,
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}

function spawnAndExit(command: string, args: string[]): never {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exit(result.status ?? 1);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

function defaultMcpUrlFromEnv() {
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

async function assertMcpAdminBearerAccepted(input: { mcpUrl: string; token: string }) {
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
          : "No DOPPLER_CONFIG in env — `pnpm cli` defaults to os/prd; override with e.g. `doppler run --project os --config preview_2 -- pnpm cli ...`.",
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
