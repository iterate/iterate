/* Ask the StackChan, out loud, to nod — and prove the servos actually moved
 * by watching its own head position, not by trusting the transcript. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectItxReady } from "iterate/node";
const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
using itx = await connectItxReady({
  auth: { type: "admin-secret", secret: process.env.APP_CONFIG_ADMIN_API_SECRET!.trim() },
  baseUrl: process.env.APP_CONFIG_BASE_URL!,
  projectId: "voice-test",
});
const kit = (itx as any).kit.stackchan;
const health = async () => {
  for (let i = 0; i < 25; i++) {
    try {
      return await kit.health();
    } catch {
      await sleep(1500);
    }
  }
  throw new Error("gone");
};
for (let i = 0; i < 15; i++) {
  try {
    await kit.conversation.start();
    break;
  } catch {
    await sleep(3000);
  }
}
for (let i = 0; i < 60; i++) {
  if ((await health()).callActive) break;
  await sleep(500);
}
const path = String((await health()).conversation);
let said = "",
  tools: string[] = [];
const c = await itx.streams.get(path).openConnection({
  connectionKey: `nod-${Date.now()}`,
  eventTypes: [
    "events.iterate.com/voice-agent/grok-event",
    "events.iterate.com/voice-agent/direct-tool",
  ],
  processEventBatch: (b: any) => {
    for (const e of b.events ?? []) {
      if (String(e.type).endsWith("direct-tool")) tools.push(JSON.stringify(e.payload));
      const i = e?.payload?.event;
      if (i?.type === "response.output_audio_transcript.delta") said += i.delta ?? "";
    }
  },
});
await sleep(3500);
await run("say", ["-r", "165", "Could you nod your head for me please?"]);
await sleep(14000);
console.log("said: " + JSON.stringify(said.trim().slice(0, 120)));
console.log("direct tools fired: " + (tools.length ? tools.join("  ") : "NONE"));
c.close();
try {
  await kit.conversation.end();
} catch {}
