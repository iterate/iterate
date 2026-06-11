// `pnpm cli itx run -e "<script body>"` — the CLI execution runtime for itx
// scripts. The script body is the SAME shape every other runtime accepts
// (browser REPL, /api/itx/run, config workers, the e2e suite): it runs with
// `itx` and `vars` in scope and ends with an explicit `return`.
//
// Evaluation happens HERE, in this Node process, over a Cap'n Web WebSocket —
// not via /api/itx/run. That makes the CLI a genuinely distinct runtime (like
// `node -e`): it can hold live capabilities and long-lived subscriptions for
// as long as the process runs.

import { readFile } from "node:fs/promises";
import process from "node:process";

import { os } from "@orpc/server";
import { RpcTarget } from "capnweb";
import { z } from "zod";

import { asPathCallable, connectItx } from "../src/itx/client.ts";

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (
  itx: unknown,
  vars: Record<string, unknown>,
  rpcTarget: unknown,
  pathCallable: unknown,
) => Promise<unknown>;

const ItxRunInput = z.object({
  eval: z
    .string()
    .optional()
    .meta({ alias: "e" })
    .describe("Inline script body. Runs with `itx` and `vars` in scope; end with `return …`."),
  file: z.string().optional().describe("Path to a script file (same body shape as --eval)."),
  context: z
    .string()
    .optional()
    .describe("Project id or slug to connect into. Omit for the global (admin) context."),
  vars: z
    .string()
    .optional()
    .describe('JSON object passed to the script as `vars`, e.g. \'{"note":"hi"}\'.'),
  baseUrl: z.string().optional().describe("OS base URL. Defaults to APP_CONFIG_BASE_URL."),
});

export const itxRunScript = os
  .meta({ description: "Run an itx script body against a deployed OS worker over Cap'n Web." })
  .input(ItxRunInput)
  .handler(async ({ input }) => {
    const code = input.eval ?? (input.file ? await readFile(input.file, "utf8") : undefined);
    if (code === undefined || (input.eval !== undefined && input.file !== undefined)) {
      throw new Error("Pass exactly one of -e/--eval or --file.");
    }

    const vars = parseVars(input.vars);
    const baseUrl = input.baseUrl ?? process.env.APP_CONFIG_BASE_URL?.trim();
    if (!baseUrl) throw new Error("No base URL: pass --base-url or set APP_CONFIG_BASE_URL.");
    const token =
      process.env.OS_ADMIN_API_SECRET?.trim() ||
      process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
      "";
    if (!token)
      throw new Error("APP_CONFIG_ADMIN_API_SECRET (or OS_ADMIN_API_SECRET) is required.");

    // The script body becomes an async function body, so `return` works and
    // `await` is available throughout — same wrapping as /api/itx/run.
    const script = new AsyncFunction("itx", "vars", "RpcTarget", "asPathCallable", code);

    using itx = connectItx({ baseUrl, context: input.context, token });
    const result = await script(itx, vars, RpcTarget, asPathCallable);

    // Exactly one JSON document on stdout — scripts and the e2e suite parse it.
    process.stdout.write(`${JSON.stringify(result ?? null, null, 2)}\n`);

    // The Cap'n Web WebSocket would otherwise keep the process alive.
    process.exit(0);
  });

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
