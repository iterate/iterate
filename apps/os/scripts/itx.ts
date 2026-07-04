// `pnpm cli itx run --eval "<script body>"` — the CLI execution runtime for itx
// scripts. The script body is the SAME shape every other runtime accepts
// (browser REPL, runScript, project workers, the e2e suite): it runs with
// `itx` and `vars` in scope and ends with an explicit `return`.
//
// Evaluation happens HERE, in this Node process, over a Cap'n Web WebSocket.
// That makes the CLI a genuinely distinct runtime (like `node -e`): it can
// hold live capabilities and long-lived subscriptions for as long as the
// process runs.

import { readFile } from "node:fs/promises";
import process from "node:process";
import repl from "node:repl";

import { RpcTarget } from "capnweb";

import { connectItx } from "../src/itx-client.ts";
import { readDevServerInfo } from "./lib/dev-server-info.ts";

const ASSISTANT_RESPONSE_TYPE = "events.iterate.com/agents/web-message-sent";

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>, rpcTarget: unknown) => Promise<unknown>;

type RunOptions = {
  /**
   * Inline script body. Runs with `itx` and `vars` in scope; end with `return ...`.
   * @alias e
   */
  eval?: string;
  /** Path to a script file with the same body shape as `eval`. */
  file?: string;
  /** Project id to connect into. Omit for the global admin session. */
  context?: string;
  /** JSON object passed to the script as `vars`, e.g. '{"note":"hi"}'. */
  vars?: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL. */
  baseUrl?: string;
};

/** Run an itx script body against a deployed OS worker over Cap'n Web. */
export async function run(options: RunOptions) {
  const code = options.eval ?? (options.file ? await readFile(options.file, "utf8") : undefined);
  if (code === undefined || (options.eval !== undefined && options.file !== undefined)) {
    throw new Error("Pass exactly one of -e/--eval or --file.");
  }

  const vars = parseVars(options.vars);
  const connection = adminConnection(options);

  // The script body becomes an async function body, so `return` works and
  // `await` is available throughout — same wrapping as every other runtime.
  const script = new AsyncFunction("itx", "vars", "RpcTarget", code);

  using itx = options.context
    ? connectItx({ ...connection, projectId: options.context })
    : connectItx(connection);
  const result = await script(itx, vars, RpcTarget).catch((error: unknown) => {
    process.stderr.write(formatScriptError(error));
    process.exit(1);
  });

  // Exactly one JSON document on stdout — scripts and the e2e suite parse it.
  process.stdout.write(`${JSON.stringify(result ?? null, null, 2)}\n`);

  // The Cap'n Web WebSocket would otherwise keep the process alive.
  process.exit(0);
}

/**
 * Message-first rendering for script failures. Most errors here are remote:
 * they crossed the Cap'n Web transport, which keeps `message` and enumerable
 * extras (Slack errors carry `code`/`data`) but replaces the stack with local
 * transport frames — so the default stack-dump rendering buries the one line
 * that matters under noise. Lead with the message, then the extras, then the
 * (local) stack for whoever needs it.
 */
export function formatScriptError(error: unknown): string {
  if (!(error instanceof Error)) return `itx script failed: ${JSON.stringify(error)}\n`;
  const extras = Object.entries(error)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`);
  const stack = error.stack?.startsWith(`${error.name}: ${error.message}`)
    ? error.stack.slice(`${error.name}: ${error.message}`.length).trimStart()
    : error.stack;
  return [
    `itx script failed: ${error.message}\n`,
    ...extras,
    ...(stack ? [`${stack.replace(/^/gm, "  ")}\n`] : []),
  ].join("");
}

type ReplOptions = {
  /** Project id to connect into. Omit for the global admin session. */
  context?: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL. */
  baseUrl?: string;
};

/** Open a Node REPL with a live itx handle (`itx`, plus `RpcTarget`). */
export async function startRepl(options: ReplOptions) {
  const connection = adminConnection(options);
  const itx = options.context
    ? connectItx({ ...connection, projectId: options.context })
    : connectItx(connection);

  process.stdout.write(
    [
      `Connected to ${connection.baseUrl}`,
      options.context
        ? `Context: project ${options.context} — try: await itx.__describe()`
        : "Context: session — try: await itx.projects.list()",
      "",
    ].join("\n"),
  );

  const server = repl.start({ prompt: "itx> " });
  server.context.itx = itx;
  server.context.RpcTarget = RpcTarget;
  server.on("exit", () => process.exit(0));
}

type AgentSmokeOptions = {
  /** Agent stream path, e.g. /agents/onboarding. */
  agentPath: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL. */
  baseUrl?: string;
  /** Single user message to send to the agent. */
  message: string;
  /** Project id to connect into over ITX. */
  project: string;
  /** Maximum time to wait for an assistant response. */
  timeoutMs?: number;
};

/** Send one user message to an agent over ITX and wait for the assistant response. */
export async function agentSmoke(options: AgentSmokeOptions) {
  const agentPath = options.agentPath.trim();
  const project = options.project.trim();
  const message = options.message.trim();
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!agentPath.startsWith("/agents/")) {
    throw new Error("Agent path must start with /agents/.");
  }
  if (!project) throw new Error("--project is required.");
  if (!message) throw new Error("--message is required.");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }

  const startedAt = Date.now();
  using agent = connectItx({
    ...adminConnection(options),
    agentPath,
    projectId: project,
  });

  // `ask` is the server-side send-and-wait: append the user message, resolve
  // on the agent's web reply. Waiting is bounded client-side as well.
  const responseEvent = await Promise.race([
    agent.ask({ message }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`No assistant response within ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  if (responseEvent.type !== ASSISTANT_RESPONSE_TYPE) {
    throw new Error(`Unexpected response event: ${JSON.stringify(responseEvent)}`);
  }
  const assistantMessage = (responseEvent.payload as { message?: unknown }).message;

  process.stdout.write(
    `${JSON.stringify(
      {
        agentPath,
        assistantMessage: typeof assistantMessage === "string" ? assistantMessage : null,
        elapsedMs: Date.now() - startedAt,
        project,
        responseEvent,
      },
      null,
      2,
    )}\n`,
  );

  // The Cap'n Web WebSocket would otherwise keep the process alive.
  process.exit(0);
}

function adminConnection(options: { baseUrl?: string }) {
  const baseUrl =
    options.baseUrl ??
    process.env.APP_CONFIG_BASE_URL?.trim() ??
    readDevServerInfo(new URL("..", import.meta.url).pathname, {
      requireLive: true,
    })?.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "No base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start the local dev server.",
    );
  }
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ?? "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");
  return { auth: { type: "admin-secret" as const, secret }, baseUrl };
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
