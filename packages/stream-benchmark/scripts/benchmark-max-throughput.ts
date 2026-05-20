#!/usr/bin/env node
/**
 * Stress-test append throughput. Reports client-observed end-to-end rate (append sent
 * until matching event received on the same WebSocket). Also prints per-connection stats.
 *
 * Usage:
 *   node scripts/benchmark-max-throughput.ts <base-url> \
 *     --mode single-do|many-do \
 *     --messages 20000 \
 *     --connections 1 \
 *     --streams 32
 */

const args = parseArgs(process.argv.slice(2));

if (!args.url) {
  console.error(`Usage: node scripts/benchmark-max-throughput.ts <base-url> \\
  [--mode single-do|many-do] [--messages 20000] [--connections 1] [--streams 32]`);
  process.exit(1);
}

if (typeof WebSocket === "undefined") {
  console.error("Requires Node.js with global WebSocket.");
  process.exit(1);
}

const baseUrl = args.url.replace(/\/$/, "");
const mode = args.mode ?? "many-do";
const messagesPerConnection = Number(args.messages ?? 20_000);
const connectionsPerTarget = mode === "single-do" ? Number(args.connections ?? 1) : 1;
const streamCount = mode === "many-do" ? Number(args.streams ?? 32) : 1;
const runId = args["run-id"] ?? crypto.randomUUID();

const targets =
  mode === "single-do"
    ? [{ path: "/bench-limit-single", connections: connectionsPerTarget }]
    : Array.from({ length: streamCount }, (_, i) => ({
        path: `/bench-limit-${String(i + 1).padStart(2, "0")}`,
        connections: 1,
      }));

console.log(
  JSON.stringify({
    type: "max-throughput-start",
    runId,
    mode,
    baseUrl,
    messagesPerConnection,
    targets: targets.length,
    totalConnections: targets.reduce((n, t) => n + t.connections, 0),
    totalMessages: targets.reduce((n, t) => n + t.connections, 0) * messagesPerConnection,
  }),
);

const startedAt = performance.now();
const results = await Promise.all(
  targets.flatMap((target) =>
    Array.from({ length: target.connections }, (_, connectionIndex) =>
      runConnection({
        url: `${toWebSocketBase(baseUrl)}${target.path}?after=end`,
        messages: messagesPerConnection,
        runId,
        label: `${target.path}#${connectionIndex}`,
      }),
    ),
  ),
);

const finishedAt = performance.now();
const elapsedSec = (finishedAt - startedAt) / 1_000;
const totalReceived = results.reduce((n, r) => n + r.received, 0);
const totalErrors = results.reduce((n, r) => n + r.errors, 0);
const perConnectionRates = results.map((r) => r.messagesPerSecond).toSorted((a, b) => a - b);

console.log(
  JSON.stringify({
    type: "max-throughput-result",
    runId,
    mode,
    elapsedSec,
    totalReceived,
    totalErrors,
    aggregateMessagesPerSecond: totalReceived / elapsedSec,
    perConnectionMessagesPerSecond: {
      min: perConnectionRates[0],
      median: perConnectionRates[Math.floor(perConnectionRates.length / 2)],
      max: perConnectionRates.at(-1),
    },
    connections: results,
  }),
);

function toWebSocketBase(raw: string) {
  const url = new URL(raw);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return `${url.origin}`;
}

async function runConnection(args: {
  url: string;
  messages: number;
  runId: string;
  label: string;
}) {
  return new Promise<{
    label: string;
    sent: number;
    received: number;
    errors: number;
    elapsedMs: number;
    messagesPerSecond: number;
    appendToReadLatencyMs?: { p50: number; p95: number; p99: number; max: number };
  }>((resolve) => {
    let openedAt = 0;
    let sent = 0;
    let received = 0;
    let errors = 0;
    const sentAtByN = new Map<number, number>();
    const latenciesMs: number[] = [];
    const ws = new WebSocket(args.url) as WebSocket & { bufferedAmount: number };

    const finish = () => {
      const elapsedMs = performance.now() - openedAt;
      const sorted = latenciesMs.toSorted((a, b) => a - b);
      resolve({
        label: args.label,
        sent,
        received,
        errors,
        elapsedMs,
        messagesPerSecond: received / (elapsedMs / 1_000),
        appendToReadLatencyMs:
          sorted.length === 0
            ? undefined
            : {
                p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
                p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
                p99: sorted[Math.floor((sorted.length - 1) * 0.99)],
                max: sorted.at(-1)!,
              },
      });
    };

    ws.addEventListener("open", () => {
      openedAt = performance.now();
      pump();
    });

    ws.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as {
        type?: string;
        event?: { metadata?: { runId?: unknown }; payload?: { n?: unknown } };
      };
      if (frame.type === "ready") return;
      if (frame.type === "error") {
        errors += 1;
        return;
      }
      if (frame.type !== "event" || frame.event?.metadata?.runId !== args.runId) return;

      received += 1;
      const n = frame.event.payload?.n;
      if (typeof n === "number") {
        const sentAt = sentAtByN.get(n);
        if (sentAt !== undefined) {
          latenciesMs.push(performance.now() - sentAt);
          sentAtByN.delete(n);
        }
      }
      if (received === args.messages) {
        ws.close(1000, "done");
        finish();
      }
    });

    ws.addEventListener("error", () => {
      errors += 1;
    });

    ws.addEventListener("close", () => {
      if (received < args.messages) finish();
    });

    function pump() {
      while (sent < args.messages && ws.bufferedAmount < 4_000_000) {
        sent += 1;
        sentAtByN.set(sent, performance.now());
        ws.send(
          JSON.stringify({
            op: "append",
            event: {
              type: "benchmark.message",
              payload: { n: sent },
              metadata: { runId: args.runId },
              source: { processor: { slug: "benchmark-max", version: "v0" } },
            },
          }),
        );
      }
      if (sent < args.messages) setImmediate(pump);
    }
  });
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
