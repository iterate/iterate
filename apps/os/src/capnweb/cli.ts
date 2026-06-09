#!/usr/bin/env npx tsx
import type { RpcStub } from "capnweb";
import type { IterateContext } from "./iterate-context-capability.ts";
import { connectNodeIterateContext, runWithProjectEgressFetch } from "./node-client.ts";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help || !flags.e) {
    printUsage();
    process.exit(flags.help ? 0 : 1);
  }

  const session = await connectNodeIterateContext({ projectId: flags["project-id"] });
  try {
    const fn = (0, eval)(`(${flags.e})`) as (input: {
      ctx: RpcStub<IterateContext>;
      vars: Record<string, unknown>;
    }) => unknown;
    const result = await runWithProjectEgressFetch(session.ctx, () =>
      fn({ ctx: session.ctx, vars: parseJsonObject(flags.vars ?? "{}") }),
    );
    console.log(JSON.stringify(result));
  } finally {
    session.close();
  }
}

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) continue;
    const name = arg === "-e" ? "e" : arg.replace(/^--?/, "");
    if (name === "help") {
      flags.help = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    flags[name] = value;
    index++;
  }
  return flags as { e?: string; help?: boolean; "project-id"?: string; vars?: string };
}

function parseJsonObject(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--vars must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function printUsage() {
  console.log(`Usage:
  doppler run -- pnpm exec tsx src/capnweb/cli.ts --project-id <proj_...> -e "async ({ ctx }) => await (await ctx.project).describe()"
  doppler run -- pnpm exec tsx src/capnweb/cli.ts -e "async ({ ctx }) => await (await ctx.projects).list()"
`);
}
