// `pnpm cli itx` — a connected itx handle in your terminal (see --help).
import process from "node:process";
import repl from "node:repl";
import { connectItx, type ItxClient } from "../src/itx/client.ts";
import { getItxErrorCode } from "../src/itx/errors.ts";

const USAGE = `Usage: pnpm cli itx [--context <projectSlugOrId>] [-e <expression>]

Connects to $APP_CONFIG_BASE_URL/api/itx[/<context>] with the admin API secret
(both provided by Doppler) and gives you an \`itx\` handle.

REPL (default)   doppler run --config prd -- pnpm cli itx --context my-project
                 itx> await itx.describe()
Inline (-e)      doppler run --config prd -- pnpm cli itx -e "await itx.describe()"
                 The argument is one JavaScript expression, evaluated with
                 \`itx\` in scope (await allowed) — exactly what you would type
                 at the REPL prompt — and the result is printed as JSON.`;

main().catch((error) => {
  const code = getItxErrorCode(error);
  console.error(code ? `ItxError ${code}: ${(error as Error).message}` : error);
  process.exit(1);
});

async function main() {
  const flags: { context?: string; eval?: string } = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const value = args[index + 1];
    if (args[index] === "--help" || args[index] === "-h") return console.log(USAGE);
    if ((args[index] !== "--context" && args[index] !== "-e") || !value) {
      throw new Error(`Unexpected argument ${args[index]}\n\n${USAGE}`);
    }
    flags[args[index] === "-e" ? "eval" : "context"] = value;
    index++;
  }

  const itx = connectItx({
    baseUrl: requireEnv("APP_CONFIG_BASE_URL"),
    token: requireEnv("APP_CONFIG_ADMIN_API_SECRET"),
    context: flags.context,
  });

  if (flags.eval) {
    // oxlint-disable-next-line no-new-func -- Evaluating the user's -e expression is the point.
    const script = new Function("itx", `return (async () => (\n${flags.eval}\n))();`);
    console.log(JSON.stringify(await (script as (itx: ItxClient) => Promise<unknown>)(itx)));
    process.exit(0);
  }

  // useGlobal keeps REPL-created object literals in the main realm — capnweb's
  // serializer rejects objects whose prototype comes from a separate vm context.
  // Top-level await is on by default in programmatic REPLs since Node 16.6.
  const server = repl.start({ prompt: `itx:${flags.context ?? "global"}> `, useGlobal: true });
  Object.assign(server.context, { itx });
  server.on("exit", () => {
    itx[Symbol.dispose]();
    process.exit(0);
  });
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — run under doppler, e.g. \`pnpm cli itx\`.`);
  return value;
}
