#!/usr/bin/env npx tsx
import repl from "node:repl";
import { connectNodeIterateContext, projectEgressFetch } from "./node-client.ts";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  const session = await connectNodeIterateContext({ projectId: flags["project-id"] });

  if (flags["project-id"]) {
    globalThis.fetch = (...args) => projectEgressFetch(session.ctx, ...args);
  }

  const server = repl.start({
    prompt: flags["project-id"] ? `iterate:${flags["project-id"]}> ` : "iterate> ",
    useGlobal: true,
  });

  // This is intentionally the normal Node REPL, not a JSON command loop.
  // `useGlobal: true` matters for Cap'n Web: object literals created inside a
  // separate vm context have a different Object prototype, and Cap'n Web's
  // serializer rejects them as non-plain objects. Running in Node's global realm
  // keeps `await ctx.projects.list({ limit: 1 })` serializable while still letting
  // variables remain live across expressions:
  //
  //   const project = await ctx.project
  //   stream = new ReadableStream()
  //   await ctx.streams.list()
  //
  // That persistence is exactly what /run cannot provide because /run returns
  // JSON and tears down the dynamic worker after each invocation.
  const replGlobal = globalThis as typeof globalThis & {
    ctx: typeof session.ctx;
    env: Record<string, unknown>;
  };
  replGlobal.ctx = session.ctx;
  replGlobal.env = {};

  server.on("exit", () => {
    session.close();
  });
}

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) continue;
    const name = arg.replace(/^--?/, "");
    if (name === "help") {
      flags.help = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    flags[name] = value;
    index++;
  }
  return flags as { help?: boolean; "project-id"?: string };
}

function printUsage() {
  console.log(`Usage:
  doppler run -- pnpm exec tsx src/capnweb/repl.ts
  doppler run -- pnpm exec tsx src/capnweb/repl.ts --project-id <proj_...>

Examples inside the REPL:
  await ctx.projects.list({ limit: 5 })

  await ctx.project.describe()
`);
}
