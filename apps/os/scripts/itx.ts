// `pnpm cli itx run --eval "<script body>"` — the CLI execution runtime for itx
// scripts. The script body is the SAME shape every other runtime accepts
// (browser REPL, /api/itx/run, project workers, the e2e suite): it runs with
// `itx` and `vars` in scope and ends with an explicit `return`.
//
// Evaluation happens HERE, in this Node process, over a Cap'n Web WebSocket —
// not via /api/itx/run. That makes the CLI a genuinely distinct runtime (like
// `node -e`): it can hold live capabilities and long-lived subscriptions for
// as long as the process runs.

import { readFile } from "node:fs/promises";
import process from "node:process";

import { RpcTarget } from "capnweb";

import { withItx } from "../src/itx/client.ts";

const ASSISTANT_RESPONSE_TYPE = "events.iterate.com/agents/web-message-sent";
const USER_MESSAGE_TYPE = "events.iterate.com/agents/user-message-received";

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
  /** Project id or slug to connect into. Omit for the global admin context. */
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
  const baseUrl = options.baseUrl ?? process.env.APP_CONFIG_BASE_URL?.trim();
  if (!baseUrl) throw new Error("No base URL: pass --base-url or set APP_CONFIG_BASE_URL.");
  const token =
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    "";
  if (!token) throw new Error("APP_CONFIG_ADMIN_API_SECRET (or OS_ADMIN_API_SECRET) is required.");

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

  const baseUrl = options.baseUrl ?? process.env.APP_CONFIG_BASE_URL?.trim();
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
