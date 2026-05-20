#!/usr/bin/env node
/**
 * External client (Node) → deployed Worker/DO over public Internet.
 *
 * Usage:
 *   pnpm exec tsx findings/harness/websocket-external-cli.ts <url> [--messages 10000]
 *   pnpm exec tsx findings/harness/websocket-external-cli.ts <url> --reconnect --messages 5000
 */

import { pumpAppendBenchmark } from "./websocket-pump.js";

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
  console.error(
    "Usage: pnpm exec tsx findings/harness/websocket-external-cli.ts <worker-url> [--messages 10000] [--after end] [--reconnect]",
  );
  process.exit(1);
}

if (typeof WebSocket === "undefined" && !args.reconnect) {
  console.error("Requires Node with global WebSocket, or pass --reconnect (uses partysocket).");
  process.exit(1);
}

const messageCount = Number(args.messages ?? 10_000);
const after = String(args.after ?? "end");
const useReconnect = args.reconnect === "true";
const runId = crypto.randomUUID();

console.log(
  JSON.stringify({
    type: "benchmark-start",
    url: args.url,
    messageCount,
    runId,
    reconnect: useReconnect,
    after,
  }),
);

const stats = await pumpAppendBenchmark({
  ws: useReconnect
    ? undefined
    : (new WebSocket(buildWebSocketUrl(args.url, after)) as WebSocket & { bufferedAmount: number }),
  url: useReconnect ? args.url : undefined,
  after,
  reconnect: useReconnect ? { maxRetries: 1_000, minReconnectionDelay: 100 } : undefined,
  messages: messageCount,
  runId,
  processorSlug: "benchmark-external-ws",
  waitForEvents: true,
});

console.log(JSON.stringify({ type: "benchmark-result", runId, ...stats }));

function buildWebSocketUrl(rawUrl: string, afterCursor: string) {
  const url = new URL(rawUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.searchParams.set("after", afterCursor);
  return url.toString();
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
