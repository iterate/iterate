import type { Stream } from "../../src/stream/v0/stream.js";
import type { AppendBenchmarkResult } from "./types.js";

export async function runRpcAppendBenchmark(args: {
  stream: DurableObjectStub<Stream>;
  messages: number;
  batchSize: number;
  path: string;
}): Promise<AppendBenchmarkResult> {
  const startedAt = performance.now();
  let committed = 0;
  const runId = crypto.randomUUID();

  if (args.batchSize <= 1) {
    for (let n = 1; n <= args.messages; n += 1) {
      await args.stream.append({
        event: {
          type: "benchmark.rpc",
          payload: { n },
          metadata: { runId },
          source: { processor: { slug: "benchmark-rpc", version: "v0" } },
        },
      });
      committed += 1;
    }
  } else {
    let n = 0;
    while (n < args.messages) {
      const batch = [];
      for (let i = 0; i < args.batchSize && n < args.messages; i += 1) {
        n += 1;
        batch.push({
          type: "benchmark.rpc",
          payload: { n },
          metadata: { runId },
          source: { processor: { slug: "benchmark-rpc", version: "v0" } },
        });
      }
      await args.stream.appendBatch({ events: batch });
      committed += batch.length;
    }
  }

  const elapsedMs = performance.now() - startedAt;
  return {
    mode: args.batchSize <= 1 ? "worker-rpc-serial" : "worker-rpc-batch",
    path: args.path,
    messages: args.messages,
    batchSize: args.batchSize,
    committed,
    sent: committed,
    received: committed,
    errors: 0,
    elapsedMs,
    appendsPerSecond: committed / (elapsedMs / 1_000),
  };
}
