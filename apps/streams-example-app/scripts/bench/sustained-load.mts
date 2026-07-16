// Paced sustained load: <ratePerSec> events/sec in batches of <batchSize> for <seconds>,
// with a 1s server-head sampler so a subscriber's lag can be computed against the
// printed timeline. Usage:
//   pnpm exec tsx scripts/bench/sustained-load.mts <wsBase> <path> [ratePerSec] [batchSize] [seconds]
import { withStreamConnectionFromNode } from "../../src/lib/node-stream-connection.ts";

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT (continuing):", error instanceof Error ? error.message : error);
});

const [wsBase, path, rateArg, batchArg, secondsArg] = process.argv.slice(2);
if (wsBase === undefined || path === undefined) {
  console.error("usage: sustained-load.mts <wsBase> <path> [ratePerSec] [batchSize] [seconds]");
  process.exit(1);
}
const ratePerSec = Number(rateArg ?? 5000);
const batchSize = Number(batchArg ?? 200);
const seconds = Number(secondsArg ?? 30);
const token = process.env.STREAMS_PLAYGROUND_TOKEN;
const url = `${wsBase}?path=${encodeURIComponent(path)}&projectId=default${
  token ? `&access_token=${token}` : ""
}`;

const connection = withStreamConnectionFromNode({ url });
const stream = connection.stream;
await stream.runtimeState();

const intervalMs = 1000 / (ratePerSec / batchSize);
const timeline: { t: number; maxOffset: number }[] = [];
let failures = 0;
let acked = 0;
const t0 = Date.now();

const sampler = setInterval(() => {
  void (async () => {
    try {
      const state = (await stream.runtimeState()) as {
        coreProcessorState: { maxOffset: number };
      };
      timeline.push({ t: Date.now(), maxOffset: state.coreProcessorState.maxOffset });
    } catch {
      // A dropped sample is fine; the load half keeps its own failure count.
    }
  })();
}, 1000);

let batchIndex = 0;
const totalBatches = Math.ceil((ratePerSec * seconds) / batchSize);
await new Promise<void>((done) => {
  const timer = setInterval(() => {
    if (batchIndex >= totalBatches) {
      clearInterval(timer);
      done();
      return;
    }
    const index = batchIndex++;
    const events = Array.from({ length: batchSize }, (_, i) => ({
      type: "events.iterate.com/random/metric-recorded",
      payload: { index: index * batchSize + i, sentAt: Date.now() },
    }));
    void (stream.append(...events) as Promise<unknown[]>).then(
      (committed) => (acked += committed.length),
      () => (failures += 1),
    );
  }, intervalMs);
});
await new Promise((resolve) => setTimeout(resolve, 3000));
clearInterval(sampler);
console.log(
  JSON.stringify({
    ratePerSec,
    batchSize,
    seconds,
    acked,
    failedBatches: failures,
    wallMs: Date.now() - t0,
    timeline,
  }),
);
connection[Symbol.dispose]();
