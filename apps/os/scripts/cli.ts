import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { RpcTarget } from "capnweb";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";

import { withItx } from "../src/itx/client.ts";

export * as artifacts from "./artifacts.ts";
export * as dev from "./dev.ts";

const DEFAULT_MCP_BASE_URL = "https://mcp.iterate.com";
const LOCAL_DEVELOPMENT_MCP_PATH = "/api/mcp";
const SERVER_NAME = "iterate";
const DEFAULT_INITIAL_PROMPT = "describe the MCP tools you have available";
const ASSISTANT_RESPONSE_TYPE = "events.iterate.com/agents/web-message-sent";
const USER_MESSAGE_TYPE = "events.iterate.com/agents/user-message-received";
const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>, rpcTarget: unknown) => Promise<unknown>;

export class Itx {
  /** Run an itx script body against a deployed OS worker over Cap'n Web. */
  async run(options: RunOptions) {
    const code = options.eval || (options.file ? await readFile(options.file, "utf8") : undefined);
    if (code === undefined || (options.eval !== undefined && options.file !== undefined)) {
      throw new Error("Pass exactly one of -e/--eval or --file.");
    }

    const vars = parseVars(options.vars);
    const baseUrl = options.baseUrl || process.env.APP_CONFIG_BASE_URL?.trim();
    if (!baseUrl) throw new Error("No base URL: pass --base-url or set APP_CONFIG_BASE_URL.");
    const token =
      process.env.OS_ADMIN_API_SECRET?.trim() ||
      process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
      "";
    if (!token) {
      throw new Error("APP_CONFIG_ADMIN_API_SECRET (or OS_ADMIN_API_SECRET) is required.");
    }

    // The script body becomes an async function body, so `return` works and
    // `await` is available throughout — same wrapping as /api/itx/run.
    const script = new AsyncFunction("itx", "vars", "RpcTarget", code);

    using itx = withItx({ baseUrl, context: options.context, token });
    const result = await script(itx, vars, RpcTarget);

    // Exactly one JSON document on stdout — scripts and the e2e suite parse it.
    process.stdout.write(`${JSON.stringify(result ?? null, null, 2)}\n`);

    // The Cap'n Web WebSocket would otherwise keep the process alive.
    process.exit(0);
  }

  /** Send one user message to an agent over ITX and wait for the assistant response. */
  async agentSmoke(options: AgentSmokeOptions) {
    const agentPath = options.agentPath.trim();
    const project = options.project.trim();
    const message = options.message.trim();
    const timeoutMs = options.timeoutMs || 180_000;
    if (!agentPath.startsWith("/agents/")) {
      throw new Error("Agent path must start with /agents/.");
    }
    if (!project) throw new Error("--project is required.");
    if (!message) throw new Error("--message is required.");
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("--timeout-ms must be a positive integer.");
    }

    const baseUrl = options.baseUrl || process.env.APP_CONFIG_BASE_URL?.trim();
    if (!baseUrl) throw new Error("No base URL: pass --base-url or set APP_CONFIG_BASE_URL.");
    const token =
      process.env.OS_ADMIN_API_SECRET?.trim() ||
      process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
      "";
    if (!token) {
      throw new Error("APP_CONFIG_ADMIN_API_SECRET (or OS_ADMIN_API_SECRET) is required.");
    }

    const startedAt = Date.now();
    using itx = withItx({ baseUrl, context: project, token });

    const stream = await itx.streams.get(agentPath);
    const userEvent = await stream.append({
      event: {
        type: USER_MESSAGE_TYPE,
        payload: {
          content: message,
          origin: "web",
        },
      },
    });

    const responseEvent = await stream.waitForEvent({
      afterOffset: userEvent.offset,
      timeoutMs,
      predicate: (event) => {
        if (event.type.endsWith("error-occurred")) {
          throw new Error(`Agent stream reported an error: ${JSON.stringify(event)}`);
        }
        return event.type === ASSISTANT_RESPONSE_TYPE;
      },
    });
    const assistantMessage = (responseEvent.payload as { message?: unknown }).message;

    process.stdout.write(
      `${JSON.stringify(
        {
          agentPath,
          assistantMessage: typeof assistantMessage === "string" ? assistantMessage : null,
          elapsedMs: Date.now() - startedAt,
          project,
          responseEvent,
          userEvent,
        },
        null,
        2,
      )}\n`,
    );

    // The Cap'n Web WebSocket would otherwise keep the process alive.
    process.exit(0);
  }
}

type ClaudeMcpOptions = {
  /** Deprecated; admin-token MCP access now exposes all projects. */
  projectSlugOrId?: string;
  /** MCP base hostname or URL, e.g. mcp.iterate.com or mcp.example.com/iterate. */
  baseHost?: string;
  /** Initial prompt passed to Claude before entering interactive mode. */
  prompt?: string;
};

type RunOptions = {
  /**
   * Inline script body. Runs with `itx` and `vars` in scope; end with `return ...`.
   * @alias e
   */
  eval?: string;
  /** Path to a script file with the same body shape as `eval`. */
  file?: string;
  /** Project id or slug to connect into. Omit for the global admin context. */
  context?: string;
  /** JSON object passed to the script as `vars`, e.g. '{"note":"hi"}'. */
  vars?: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL. */
  baseUrl?: string;
};

type AgentSmokeOptions = {
  /** Agent stream path, e.g. /agents/smoke. */
  agentPath: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL. */
  baseUrl?: string;
  /** Single user message to send to the agent. */
  message: string;
  /** Project id or slug to connect into over ITX. */
  project: string;
  /** Maximum time to wait for an assistant response. */
  timeoutMs?: number;
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

function parseVars(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `--vars must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--vars must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
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
