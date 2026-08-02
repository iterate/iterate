// One device turn, with everything on the stream printed as it happens.
import { connectProject } from "./connect.ts";

const project = process.argv[2]!;
const path = process.argv[3] ?? "/voicelab/device";
const hold = Number(process.argv[4] ?? 4);

const itx = await connectProject({ project });
const stream = itx.streams.get(path);
const kit = (itx as unknown as { kit: Record<string, any> }).kit;
const device = kit.waveshare;

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let mic = 0;
let spk = 0;
let transcript = "";

await stream.openConnection({
  connectionKey: `trace-${Date.now()}`,
  eventTypes: [
    "voicelab/mic-frame",
    "voicelab/spk-frame",
    "voicelab/turn",
    "voicelab/turn-committed",
    "voicelab/grok-event",
    "voicelab/call-accepted",
    "voicelab/call-ended",
    "voicelab/bridge-redialling",
    "voicelab/colleague-asked",
    "voicelab/pong",
  ],
  processEventBatch: (batch: { events: { type: string; offset?: number; payload?: any }[] }) => {
    for (const event of batch.events) {
      if (event.type === "voicelab/mic-frame") {
        mic++;
        continue;
      }
      if (event.type === "voicelab/spk-frame") {
        spk++;
        continue;
      }
      if (event.type === "voicelab/grok-event") {
        const inner = event.payload?.event;
        if (inner?.type === "response.output_audio_transcript.delta") {
          transcript += inner.delta ?? "";
          continue;
        }
        console.log(`${at()} grok ${inner?.type} ${JSON.stringify(inner).slice(0, 220)}`);
        continue;
      }
      console.log(
        `${at()} @${(event as any).offset} ${event.type} ${JSON.stringify(event.payload).slice(0, 200)}`,
      );
    }
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log(`${at()} hang up any stale call`);
await device.conversation.hangUp().catch(() => {});
await sleep(1500);
console.log(`${at()} press call`);
await device.conversation.start();
const poll = setInterval(async () => {
  try {
    const h = await device.health();
    console.log(
      `${at()} device call=${h.callActive} pending=${h.callPending} wants=${h.wantsCall} bridgeAge=${h.bridgeAgeMs} batches=${h.batches} conn=${h.connGeneration} rtt=${h.rttMs} frames=${h.framesSent} spkPlayed=${h.spkPlayed}`,
    );
  } catch (error) {
    console.log(`${at()} health failed: ${String(error).slice(0, 60)}`);
  }
}, 3000);
for (let i = 0; i < 40 && spk + mic === 0; i++) await sleep(500);
await sleep(2000);
console.log(`${at()} hold talk`);
await device.pushToTalk.start();
await sleep(hold * 1000);
console.log(`${at()} release`);
await device.pushToTalk.stop();
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  if (i % 5 === 4)
    console.log(`${at()} mic=${mic} spk=${spk} transcript=${transcript.slice(0, 80)}`);
}
clearInterval(poll);
const health = await device.health();
console.log(`${at()} FINAL mic=${mic} spk=${spk}`);
console.log(`transcript: ${transcript}`);
console.log(
  `health: spkPlayed=${health.spkPlayed} spkWrites=${health.spkWrites} spkConceal=${health.spkConceal} spkUnderruns=${health.spkUnderruns} spkOverflow=${health.spkOverflow} spkMarginMaxMs=${health.spkMarginMaxMs} framesSent=${health.framesSent} rttMs=${health.rttMs} batches=${health.batches} inboxDiscarded=${health.inboxDiscarded} outboxDiscarded=${health.outboxDiscarded}`,
);
process.exit(0);
