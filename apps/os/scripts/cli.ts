import { spawnSync } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";

export * as configRepo from "./reset-config-repo.ts";
export * as dev from "./dev.ts";
export * as itx from "./itx.ts";
export * as projectSeed from "./project-seed.ts";
export * as session from "./session.ts";
export * as voicelab from "./voicelab/index.ts";

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
  /** Include the ask_assistant tool in addition to exec_typescript. */
  withAgent?: boolean;
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
  const mcpUrl = applyClaudeMcpToolOptions(
    baseHost ? normalizeBaseUrl(baseHost) : defaultMcpUrlFromEnv(),
    options,
  );
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

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);

  /**
   * `pnpm cli` should mean "run the OS CLI for the current Doppler environment".
   * Project-seed capture is the deliberate exception: a direct invocation
   * defaults to production, because its whole purpose is taking the stable
   * pre-erase archive. `--environment` selects another exact OS config.
   *
   * If the caller is already inside `doppler run`, preserve that exact config:
   *
   * If not, enter Doppler without naming a project or config. Doppler then uses
   * the user's local `doppler setup` for `apps/os`, normally `dev_<user>`.
   */
  if (!process.env.DOPPLER_CONFIG && isVoicelabTalk(args) && !isHelpRequest(args)) {
    const environment =
      optionValue(args, "--environment") ??
      (await promptWithDefault("Environment", process.env.ITERATE_ENV?.trim() || "preview_3"));
    spawnAndExit("doppler", [
      "run",
      "--project",
      "os",
      "--config",
      environment,
      "--",
      "tsx",
      fileURLToPath(import.meta.url),
      ...args,
    ]);
  }
  if (!process.env.DOPPLER_CONFIG && !(isVoicelabTalk(args) && isHelpRequest(args))) {
    const captureEnvironment = projectSeedCaptureEnvironment(args);
    if (captureEnvironment !== null) {
      spawnAndExit("doppler", [
        "run",
        "--project",
        "os",
        "--config",
        captureEnvironment,
        "--",
        "tsx",
        fileURLToPath(import.meta.url),
        ...args,
      ]);
    }
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

function isVoicelabTalk(args: readonly string[]): boolean {
  return args[0] === "voicelab" && args[1] === "talk";
}

function isHelpRequest(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const equalsArgument = args.find((argument) => argument.startsWith(`${name}=`));
  if (equalsArgument !== undefined)
    return equalsArgument.slice(name.length + 1).trim() || undefined;
  const flagIndex = args.indexOf(name);
  return flagIndex === -1 ? undefined : args[flagIndex + 1]?.trim() || undefined;
}

async function promptWithDefault(label: string, defaultValue: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultValue;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(`${label} [${defaultValue}]: `)).trim() || defaultValue;
  } finally {
    input.close();
  }
}

function projectSeedCaptureEnvironment(args: readonly string[]): string | null {
  if (args[0] !== "project-seed" || args[1] !== "capture") return null;
  const equalsArgument = args.find((argument) => argument.startsWith("--environment="));
  if (equalsArgument !== undefined) {
    return equalsArgument.slice("--environment=".length).trim() || "prd";
  }
  const flagIndex = args.indexOf("--environment");
  if (flagIndex !== -1) return args[flagIndex + 1]?.trim() || "prd";
  return "prd";
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

function applyClaudeMcpToolOptions(baseUrl: string, options: Pick<ClaudeMcpOptions, "withAgent">) {
  if (!options.withAgent) return baseUrl;

  const parsed = new URL(baseUrl);
  parsed.searchParams.set("withAgent", "true");
  return parsed.toString();
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
