#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));

if (!args.url) {
  console.error(
    "Usage: node scripts/benchmark-websocket.ts <worker-url-or-ws-url> [--messages 1000] [--after end] [--payload-bytes 0]",
  );
  process.exit(1);
}

if (typeof WebSocket === "undefined") {
  console.error("This script requires a Node.js runtime with global WebSocket support.");
  process.exit(1);
}

const messageCount = Number(args.messages ?? 1_000);
const payloadBytes = Number(args["payload-bytes"] ?? 0);
const after = String(args.after ?? "end");
const runId = args["run-id"] ?? crypto.randomUUID();
const url = buildWebSocketUrl(args.url, after);
const payload = payloadBytes > 0 ? "x".repeat(payloadBytes) : undefined;

let openedAt = 0;
let firstEventAt: number | undefined;
let sent = 0;
let received = 0;
let errors = 0;
let cfRay: string | undefined;
const sentAtByMessageNumber = new Map<number, number>();
const appendToReadLatenciesMs: number[] = [];

console.log(JSON.stringify({ type: "benchmark-start", url, messageCount, payloadBytes, runId }));

const ws = new WebSocket(url) as WebSocket & { bufferedAmount: number };

ws.addEventListener("open", () => {
  openedAt = performance.now();
  pump();
});

ws.addEventListener("message", (message) => {
  const frame = JSON.parse(String(message.data)) as {
    type?: unknown;
    cfRay?: unknown;
    event?: { metadata?: { runId?: unknown }; payload?: { n?: unknown } };
  };

  if (frame.type === "ready") {
    cfRay = typeof frame.cfRay === "string" ? frame.cfRay : undefined;
    console.log(JSON.stringify({ type: "benchmark-ready", runId, cfRay }));
    return;
  }

  if (frame.type === "error") {
    errors += 1;
    console.error(JSON.stringify(frame));
    return;
  }

  if (frame.type !== "event" || frame.event?.metadata?.runId !== runId) {
    return;
  }

  firstEventAt ??= performance.now();
  received += 1;
  const messageNumber = frame.event.payload?.n;
  if (typeof messageNumber === "number") {
    const sentAt = sentAtByMessageNumber.get(messageNumber);
    if (sentAt !== undefined) {
      appendToReadLatenciesMs.push(performance.now() - sentAt);
      sentAtByMessageNumber.delete(messageNumber);
    }
  }

  if (received === messageCount) {
    const finishedAt = performance.now();
    const elapsedMs = finishedAt - openedAt;
    const sortedLatencies = appendToReadLatenciesMs.toSorted((a, b) => a - b);
    ws.close(1000, "benchmark complete");
    console.log(
      JSON.stringify({
        type: "benchmark-result",
        runId,
        sent,
        received,
        errors,
        cfRay,
        elapsedMs,
        firstEventMs: firstEventAt - openedAt,
        messagesPerSecond: received / (elapsedMs / 1_000),
        appendToReadLatencyMs:
          sortedLatencies.length === 0
            ? undefined
            : {
                count: sortedLatencies.length,
                min: sortedLatencies[0],
                avg:
                  sortedLatencies.reduce((total, value) => total + value, 0) /
                  sortedLatencies.length,
                p50: sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.5)],
                p95: sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.95)],
                p99: sortedLatencies[Math.floor((sortedLatencies.length - 1) * 0.99)],
                max: sortedLatencies.at(-1),
              },
      }),
    );
  }
});

ws.addEventListener("close", (event) => {
  if (received !== messageCount) {
    console.log(
      JSON.stringify({
        type: "benchmark-incomplete",
        runId,
        sent,
        received,
        errors,
        cfRay,
        appendToReadLatencySamples: appendToReadLatenciesMs.length,
        code: event.code,
        reason: event.reason,
      }),
    );
  }
});

ws.addEventListener("error", () => {
  errors += 1;
});

function pump() {
  while (sent < messageCount && ws.bufferedAmount < 1_000_000) {
    sent += 1;
    sentAtByMessageNumber.set(sent, performance.now());
    ws.send(
      JSON.stringify({
        op: "append",
        event: {
          type: "benchmark.message",
          payload: payload === undefined ? { n: sent } : { n: sent, data: payload },
          metadata: { runId },
          source: { processor: { slug: "benchmark-websocket", version: "v0" } },
        },
      }),
    );
  }

  if (sent < messageCount) {
    setImmediate(pump);
  }
}

function buildWebSocketUrl(rawUrl: string, after: string) {
  const url = new URL(rawUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.searchParams.set("after", after);
  return url.toString();
}

function parseArgs(argv: string[]): Record<string, string | undefined> & { url?: string } {
  const parsed: Record<string, string | undefined> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }

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
