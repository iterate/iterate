// scripts/voice-board.ts — prove a physical board end to end on os-next, out loud, through real air.
//
// The board holds its own session to the worker and lent its capabilities on the project root
// (`itx.clients.<device_name>`, underscores for anything that is not an identifier character). This
// script asks it to start a conversation (a remote press), watches the conversation's context for
// what the provider heard and said, speaks the prompt out of this Mac's speaker so the board's
// microphone has to hear it, and reports the four facts the apps/os `voicelab boards` proof asks:
// the call became active (and how long that took), microphone frames left the device, an answer
// reached its speaker, and the provider transcribed the words and the board answered them.
//
//   WORKER_BASE_URL=https://auth.iterate2.com ADMIN_API_SECRET=… PROJECT=prj-voice \
//   pnpm exec tsx scripts/voice-board.ts --device home_assistant_voice_preview_edition \
//     --prompt "Hello there. Please reply with the single word banana." --expect banana
//
// `--expect` is a case-insensitive regular expression tested against what the board said back;
// models say numbers as digits or as words, so ask for either: --expect "132|thirty-two".
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adminCredentials, disposeSessions, session } from "../e2e/support/client.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key?.startsWith("--") || !value) throw new Error(`usage: --flag value…, got ${key}`);
  args.set(key.slice(2), value);
}
const PROJECT = process.env.PROJECT || "prj-voice";
const DEVICE = args.get("device") || "home_assistant_voice_preview_edition";
const PROMPT = args.get("prompt") || "Hello there. Please reply with the single word banana.";
const EXPECT = new RegExp(args.get("expect") || "banana", "i");
const T = "events.iterate.com/voice-agent/";

type Health = Record<string, unknown> & {
  callActive?: boolean;
  conversation?: string;
  framesSent?: number;
  spkWrites?: number;
  uptimeMs?: number;
};

/** Adopting a fresh conversation remounts the device; its capability is briefly away. */
async function healthWithRetry(kit: any, attempts = 20): Promise<Health> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return JSON.parse(JSON.stringify(await kit.health())) as Health;
    } catch (error) {
      last = error;
      await sleep(1500);
    }
  }
  throw last;
}

async function main(): Promise<void> {
  const root = session().authenticate(adminCredentials()).projects.get(PROJECT);
  await root.invoke(["itx", ["whoami"]]);
  const kit = root.clients[DEVICE];
  const before = await healthWithRetry(kit);
  console.log(
    `before: ${JSON.stringify({ framesSent: before.framesSent, spkWrites: before.spkWrites, uptimeMs: before.uptimeMs, callActive: before.callActive })}`,
  );

  const askedAt = Date.now();
  await kit.conversation.start();
  let callActiveMs: number | null = null;
  let streamPath = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    const health = await healthWithRetry(kit);
    if (health.callActive) {
      callActiveMs = Date.now() - askedAt;
      streamPath = String(health.conversation || "");
      break;
    }
    await sleep(500);
  }
  console.log(
    `call active after ${String(callActiveMs)} ms on ${streamPath || "(no stream path reported)"}`,
  );
  if (callActiveMs === null) throw new Error("FAIL: call never became active");
  if (!streamPath) throw new Error("FAIL: health did not report the conversation's stream path");

  // WATCH BEFORE SPEAKING: transcripts are durable, speaker frames are not; a subscription opened
  // before the words are said sees both.
  const call = root.cd(streamPath);
  let heardUs = "";
  let saidBack = "";
  let answers = 0;
  const errors: string[] = [];
  await call.subscribe({
    name: `voice-board-${askedAt}`,
    consumes: [
      `${T}spk-frame`,
      `${T}utterance-transcript`,
      `${T}answer-transcript`,
      `${T}provider-error`,
      `${T}provider-disconnected`,
      `${T}conversation-ended`,
    ],
    target: (events: any[]) => {
      for (const raw of events) {
        const event = JSON.parse(JSON.stringify(raw));
        const kind = String(event.type).slice(T.length);
        const p = event.payload ?? {};
        if (kind === "spk-frame" && p.lastFrameOfAnswer) answers += 1;
        else if (kind === "utterance-transcript") heardUs += ` ${p.text}`;
        else if (kind === "answer-transcript") saidBack += ` ${p.text}`;
        else if (kind === "provider-error" || kind === "provider-disconnected")
          errors.push(`${kind}: ${JSON.stringify(p).slice(0, 200)}`);
        else if (kind === "conversation-ended") errors.push(`ended: ${String(p.reason)}`);
      }
    },
  });

  await sleep(3000);
  console.log(`speaking: ${PROMPT}`);
  await run("say", ["-r", "170", PROMPT]);

  let after: Health = before;
  for (let attempt = 0; attempt < 40; attempt++) {
    after = await healthWithRetry(kit);
    if (EXPECT.test(saidBack) && answers > 0) break;
    await sleep(1000);
  }
  await sleep(1500);
  try {
    await kit.conversation.end();
  } catch (error) {
    errors.push(`end: ${String(error).slice(0, 100)}`);
  }

  // The words are the verdict. The board's frame and speaker counters are per call and the
  // last health read may land in the next one, so they are reported, not judged.
  const framesSent = Number(after.framesSent ?? 0);
  const spkWrites = Number(after.spkWrites ?? 0);
  const verdict = EXPECT.test(saidBack)
    ? "PASS"
    : `FAIL: heard "${heardUs.trim()}", said "${saidBack.trim()}" (expected /${EXPECT.source}/i)`;
  console.log(
    JSON.stringify(
      {
        device: DEVICE,
        streamPath,
        callActiveMs,
        framesSent,
        spkWrites,
        answers,
        heardUs: heardUs.trim(),
        saidBack: saidBack.trim(),
        errors,
        verdict,
      },
      null,
      2,
    ),
  );
  disposeSessions();
  process.exit(verdict === "PASS" ? 0 : 1);
}

await main();
