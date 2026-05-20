#!/usr/bin/env node
/**
 * Chaos monkey: randomly kill Stream / StreamV1 / StreamProcessor DOs via Worker HTTP API.
 *
 * Usage:
 *   pnpm exec tsx findings/harness/chaos-monkey.ts <worker-base-url> \
 *     --binding stream-v1 \
 *     --path-prefix /bench-chaos \
 *     --paths 10 \
 *     --duration-ms 120000 \
 *     --interval-ms 3000 \
 *     --kills-per-tick 1
 *
 * Single kill:
 *   pnpm exec tsx findings/harness/chaos-monkey.ts <base> --kill-once --binding stream --path /bench-alpha
 */

import type { KillAttempt } from "./chaos.js";

void main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args.url ?? "").replace(/\/$/, "");

  if (!baseUrl) {
    console.error(`Usage: pnpm exec tsx findings/harness/chaos-monkey.ts <worker-base-url> [options]

Options:
  --binding stream|stream-v1|stream-processor   (default: stream)
  --path-prefix /bench-chaos                    (default: /bench-chaos)
  --paths 10                                    candidate paths (suffix -01, -02, …)
  --duration-ms 120000                          loop duration
  --interval-ms 3000                          pause between ticks
  --kills-per-tick 1                            random kills per tick
  --reason "chaos"                              passed to ctx.abort
  --kill-once --path /foo                       single kill (no loop)
`);
    process.exit(1);
  }

  if (args["kill-once"] === "true") {
    const path = args.path;
    if (!path) {
      console.error("--kill-once requires --path");
      process.exit(1);
    }
    const result = await killViaHttp({
      baseUrl,
      binding: parseBinding(args.binding),
      path,
      reason: args.reason ?? "chaos-monkey",
    });
    console.log(JSON.stringify({ type: "chaos-kill-once", ...result }));
    process.exit(0);
  }

  const body = {
    binding: parseBinding(args.binding),
    pathPrefix: args["path-prefix"] ?? "/bench-chaos",
    pathCount: Number(args.paths ?? 10),
    durationMs: Number(args["duration-ms"] ?? 120_000),
    intervalMs: Number(args["interval-ms"] ?? 3_000),
    killsPerTick: Number(args["kills-per-tick"] ?? 1),
    reason: args.reason ?? "chaos-monkey",
  };

  console.log(JSON.stringify({ type: "chaos-start", baseUrl, ...body }));

  const response = await fetch(`${baseUrl}/chaos/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(text);
    process.exit(1);
  }

  console.log(text);
}

async function killViaHttp(args: {
  baseUrl: string;
  binding: string;
  path: string;
  reason: string;
}): Promise<KillAttempt> {
  const url = new URL(`${args.baseUrl}/chaos/kill`);
  url.searchParams.set("binding", args.binding);
  url.searchParams.set("path", args.path);
  url.searchParams.set("reason", args.reason);
  const response = await fetch(url, { method: "POST" });
  return (await response.json()) as KillAttempt;
}

function parseBinding(value: string | undefined) {
  if (value === "stream-v1" || value === "stream-processor" || value === "stream") {
    return value;
  }
  return "stream";
}

function parseArgs(argv: string[]): Record<string, string | undefined> & { url?: string } {
  const parsed: Record<string, string | undefined> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = "true";
    }
  }
  parsed.url = positional[0];
  return parsed;
}
