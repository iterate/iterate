// Stream backend benchmark harness (node → capnweb WebSocket → worker → Stream DO).
//
// Subcommands:
//   state <wsBase> <path>                        print the stream's maxOffset
//   rtt   <wsBase> <path> [n]                    sequential single-event appends; latency distribution
//   burst <wsBase> <path> <count> <batchSize> [payloadBytes] [concurrency]
//         append `count` events in batches; concurrency 0 fires every batch at once
//         (deliberately abusive — expect DO overload shedding above ~1000 in-flight),
//         concurrency N keeps N batches in flight. Always cross-checks the ack count
//         against the server's offset delta, so silent loss/duplication is visible.
//   read  <wsBase> <path> <fromOffset> <toOffset> [pageSize]   getEvents paging throughput
//
// Deployed environments require STREAMS_PLAYGROUND_TOKEN (see e2e/auth.ts):
//   doppler run --project streams-example-app --config <env> -- \
//     env WORKER_URL=https://streams.<domain> pnpm exec tsx e2e/auth.ts
//
// Example:
//   STREAMS_PLAYGROUND_TOKEN=... pnpm exec tsx scripts/bench/bench-stream.mts \
//     burst wss://streams.iterate-preview-3.com/api/streams /bench-b100 100000 100 64 20
import { withStreamConnectionFromNode } from "../../src/lib/node-stream-connection.ts";

// The overload error a shedding Durable Object sends back can crash capnweb's
// read loop during deserialization; keep the process alive so the run still
// reports what it measured.
process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT (continuing):", error instanceof Error ? error.message : error);
});

const [cmd, wsBase, path, ...rest] = process.argv.slice(2);
if (cmd === undefined || wsBase === undefined || path === undefined) {
  console.error("usage: bench-stream.mts <state|rtt|burst|read> <wsBase> <path> [...]");
  process.exit(1);
}
const token = process.env.STREAMS_PLAYGROUND_TOKEN;
const url = `${wsBase}?path=${encodeURIComponent(path)}&projectId=default${
  token ? `&access_token=${token}` : ""
}`;

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(label: string, samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  console.log(
    `${label}: n=${s.length} p50=${percentile(s, 50)?.toFixed(1)}ms p90=${percentile(s, 90)?.toFixed(1)}ms p99=${percentile(s, 99)?.toFixed(1)}ms min=${s[0]?.toFixed(1)} max=${s.at(-1)?.toFixed(1)}`,
  );
}

function makePayload(bytes: number, index: number) {
  return { index, sentAt: Date.now(), pad: "x".repeat(Math.max(0, bytes)) };
}

type CoreState = { coreProcessorState: { maxOffset: number } };

const connection = withStreamConnectionFromNode({ url });
const stream = connection.stream;

async function maxOffset(): Promise<number> {
  const state = (await stream.runtimeState()) as CoreState;
  return state.coreProcessorState.maxOffset;
}

if (cmd === "state") {
  console.log(JSON.stringify({ maxOffset: await maxOffset() }));
} else if (cmd === "rtt") {
  const n = Number(rest[0] ?? 100);
  await stream.runtimeState(); // warm the socket + DO
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await stream.append({
      type: "events.iterate.com/random/ping-sent",
      payload: makePayload(64, i),
    });
    samples.push(performance.now() - t0);
  }
  summarize(`rtt append(1) ${path}`, samples);
} else if (cmd === "burst") {
  const count = Number(rest[0] ?? 100_000);
  const batchSize = Number(rest[1] ?? 100);
  const payloadBytes = Number(rest[2] ?? 64);
  const concurrency = Number(rest[3] ?? 0);
  const before = await maxOffset();
  const batchCount = Math.ceil(count / batchSize);
  const latencies: number[] = [];
  let acked = 0;
  const failures = new Map<string, number>();
  const t0 = performance.now();

  const runBatch = async (batchIndex: number) => {
    const startIndex = batchIndex * batchSize;
    const events = Array.from({ length: Math.min(batchSize, count - startIndex) }, (_, i) => ({
      type: "events.iterate.com/random/ping-sent",
      payload: makePayload(payloadBytes, startIndex + i),
    }));
    const b0 = performance.now();
    try {
      const committed = (await stream.append(...events)) as unknown[];
      latencies.push(performance.now() - b0);
      acked += committed.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(message, (failures.get(message) ?? 0) + 1);
    }
  };

  if (concurrency > 0) {
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < batchCount) await runBatch(next++);
      }),
    );
  } else {
    await Promise.all(Array.from({ length: batchCount }, (_, i) => runBatch(i)));
  }
  const wallMs = performance.now() - t0;
  const after = await maxOffset();
  console.log(
    JSON.stringify({
      path,
      count,
      batchSize,
      payloadBytes,
      concurrency,
      wallMs: Math.round(wallMs),
      eventsPerSec: Math.round((acked / wallMs) * 1000),
      acked,
      before,
      after,
      offsetDelta: after - before,
      correct: after - before === acked && acked === count,
    }),
  );
  summarize("batch append latency", latencies);
  for (const [message, n] of failures) console.log(`FAIL x${n}: ${message.slice(0, 160)}`);
} else if (cmd === "read") {
  const from = Number(rest[0] ?? 0);
  const to = Number(rest[1] ?? 10_000);
  const pageSize = Number(rest[2] ?? 500);
  let cursor = from;
  let total = 0;
  const t0 = performance.now();
  while (cursor < to) {
    const page = (await stream.getEvents({ afterOffset: cursor, limit: pageSize })) as {
      offset: number;
    }[];
    if (page.length === 0) break;
    total += page.length;
    cursor = page.at(-1)!.offset;
  }
  const wallMs = performance.now() - t0;
  console.log(
    JSON.stringify({
      read: total,
      pageSize,
      wallMs: Math.round(wallMs),
      eventsPerSec: Math.round((total / wallMs) * 1000),
    }),
  );
} else {
  console.error("unknown command", cmd);
  process.exit(1);
}
connection[Symbol.dispose]();
