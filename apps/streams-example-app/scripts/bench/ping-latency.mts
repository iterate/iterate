// Appends N single "ping" events (one per interval) and prints {offset, sentAt, ackAt}
// pairs. Pair with a browser-side sampler polling __streamRuntimeDebug's
// lastDeliveredOffset (see README.md) to measure append→browser-mirror latency.
// Usage:
//   pnpm exec tsx scripts/bench/ping-latency.mts <wsBase> <path> [n] [intervalMs]
import { withStreamConnectionFromNode } from "../../src/lib/node-stream-connection.ts";

const [wsBase, path, nArg, intervalArg] = process.argv.slice(2);
if (!wsBase || !path) {
  console.error("usage: ping-latency.mts <wsBase> <path> [n] [intervalMs]");
  process.exit(1);
}
const n = Number(nArg ?? 20);
const intervalMs = Number(intervalArg ?? 1000);
const token = process.env.STREAMS_PLAYGROUND_TOKEN;
const url = `${wsBase}?path=${encodeURIComponent(path)}&projectId=default${
  token ? `&access_token=${token}` : ""
}`;
const connection = withStreamConnectionFromNode({ url });
const stream = connection.stream;
await stream.runtimeState(); // warm the socket + DO

const pings: { offset: number; sentAt: number; ackAt: number }[] = [];
for (let i = 0; i < n; i++) {
  const sentAt = Date.now();
  const [committed] = (await stream.append({
    type: "events.iterate.com/random/ping-sent",
    payload: { ping: i, sentAt },
  })) as { offset: number }[];
  pings.push({ offset: committed!.offset, sentAt, ackAt: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
console.log(JSON.stringify(pings));
connection[Symbol.dispose]();
