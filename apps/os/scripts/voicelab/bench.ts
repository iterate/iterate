// Transport-only stream benchmark: floods ephemeral PCM-sized events through a
// stream at a realtime audio cadence and measures what a voice pipe would feel —
// one-way append→delivery latency (same process, same clock), loss, duplicate
// delivery, delivery stalls, and whether a subscriber connection degrades after
// ~1000 pushes (the suspected per-connection subrequest ceiling, see
// apps/streams-example-app/scripts/bench/README.md).
//
//   doppler run --config dev -- pnpm cli voicelab bench --project prj_… --seconds 60
import crypto from "node:crypto";
import { percentiles } from "./audio.ts";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { openResilientConnection } from "./resilient.ts";
import { RpcResultObserver } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab bench`. */
export interface BenchOptions extends VoicelabConnectOptions {
  /** Stream path to bench against. Defaults to a fresh /voicelab/bench-<ts>. */
  path?: string;
  /** Frames per second to append (voice = 50). */
  rate?: number;
  /** How long to keep appending. */
  seconds?: number;
  /** Events coalesced into one atomic append() call. */
  framesPerAppend?: number;
  /** PCM bytes per frame before base64 (20ms @ 16kHz = 640). */
  frameBytes?: number;
}

export async function bench(options: BenchOptions) {
  const rate = options.rate ?? 50;
  const seconds = options.seconds ?? 120;
  const framesPerAppend = options.framesPerAppend ?? 1;
  const frameBytes = options.frameBytes ?? 640;
  const path = options.path ?? `/voicelab/bench-${Date.now()}`;
  const total = Math.floor(rate * seconds);

  // Two independent Cap'n Web sockets: the subscriber leg must not share the
  // appender's socket or per-socket limits would blur together.
  using sub = await connectProject(options);
  using pub = await connectProject(options);

  const recvBySeq = new Map<number, number>();
  let dupes = 0;
  let recvCount = 0;
  let lastRecvAt = 0;
  const oneWay: { seq: number; ms: number; at: number }[] = [];
  const batchSizes: number[] = [];
  const stalls: { fromSeq: number; gapMs: number; at: number }[] = [];

  let sending = true;
  using subStream = sub.streams.get(path);
  const connection = await openResilientConnection(subStream, {
    connectionKey: `voicelab-bench-${crypto.randomUUID().slice(0, 8)}`,
    eventTypes: ["voice-agent/bench-frame"],
    quietMs: 1500,
    trafficExpected: () => sending,
    onEvents: (events, batch) => {
      const now = Date.now();
      batchSizes.push(batch.events.length);
      for (const event of events) {
        const payload = event.payload as { seq: number; t: number };
        if (recvBySeq.has(payload.seq)) {
          dupes++;
          continue;
        }
        recvBySeq.set(payload.seq, now);
        recvCount++;
        if (lastRecvAt > 0 && now - lastRecvAt > 1000) {
          stalls.push({ fromSeq: payload.seq, gapMs: now - lastRecvAt, at: now });
        }
        lastRecvAt = now;
        oneWay.push({ seq: payload.seq, ms: now - payload.t, at: now });
      }
    },
  });

  using pubStream = pub.streams.get(path);
  let appendErrors = 0;
  let firstAppendError: string | undefined;
  const ackLatency: number[] = [];
  const appendResults = new RpcResultObserver((error: unknown) => {
    appendErrors++;
    firstAppendError ??= error instanceof Error ? error.message : String(error);
  });

  const startedAt = Date.now();
  let seq = 0;
  console.error(
    `bench: path=${path} rate=${rate}/s seconds=${seconds} framesPerAppend=${framesPerAppend} frameBytes=${frameBytes} total=${total}`,
  );

  while (seq < total) {
    const due = startedAt + (seq / rate) * 1000;
    const wait = due - Date.now();
    if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait));
    const events = [];
    for (let i = 0; i < framesPerAppend && seq < total; i++, seq++) {
      events.push({
        type: "voice-agent/bench-frame",
        ephemeral: true as const,
        payload: {
          seq,
          t: Date.now(),
          pcm: crypto.randomBytes(frameBytes).toString("base64"),
        },
      });
    }
    const isSampled = seq % (rate * 2) < framesPerAppend; // ~every 2s
    const promise = pubStream.append(...events);
    if (isSampled) {
      const sentAt = Date.now();
      appendResults.observe(promise, () => ackLatency.push(Date.now() - sentAt));
    } else {
      appendResults.observe(promise);
    }
    if (seq % (rate * 10) < framesPerAppend) {
      console.error(
        `  sent=${seq} recv=${recvCount} inflightLoss=${seq - recvCount} lastOneWayMs=${oneWay.at(-1)?.ms ?? "-"}`,
      );
    }
  }

  // Grace period for stragglers.
  sending = false;
  await appendResults.drain();
  await new Promise((resolve) => setTimeout(resolve, 5000));
  connection.close();

  // Per-10s buckets show degradation over connection lifetime (the ~1000-push
  // ceiling would appear as a cliff, not an average).
  const buckets = new Map<number, number[]>();
  for (const sample of oneWay) {
    const bucket = Math.floor((sample.at - startedAt) / 10_000);
    let list = buckets.get(bucket);
    if (!list) buckets.set(bucket, (list = []));
    list.push(sample.ms);
  }

  const summary = {
    path,
    config: { rate, seconds, framesPerAppend, frameBytes, total },
    sent: seq,
    received: recvCount,
    lost: seq - recvCount,
    dupes,
    appendErrors,
    ...(firstAppendError === undefined ? {} : { firstAppendError }),
    oneWayMs: percentiles(oneWay.map((s) => s.ms)),
    oneWayMsByTenSeconds: Object.fromEntries(
      [...buckets.entries()].map(([bucket, list]) => [`${bucket * 10}s`, percentiles(list)]),
    ),
    appendAckMs: percentiles(ackLatency),
    deliveryBatchSizes: percentiles(batchSizes),
    stalls,
    connection: connection.stats(),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.lost > 0 || summary.appendErrors > 0 || stalls.length > 0 ? 2 : 0);
}
