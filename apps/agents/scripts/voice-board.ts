// scripts/voice-board.ts — prove a physical board end to end on the platform, out loud, through real air.
//
// The board holds its own session to the worker and lent its capabilities on the project root
// (`itx.clients.<device_name>`, underscores for anything that is not an identifier character). This
// script asks it to start a conversation (a remote press), watches the conversation's context for
// what the provider heard and said, speaks the prompt out of this Mac's speaker so the board's
// microphone has to hear it, and reports the end-to-end evidence:
// the call became active (and how long that took), microphone frames left the device, an answer
// reached its speaker, and the provider transcribed the words and the board answered them.
//
//   WORKER_BASE_URL=https://os.iterate.com ITERATE_BEARER_TOKEN=itk_… PROJECT=prj-voice \
//   pnpm exec tsx scripts/voice-board.ts --device home_assistant_voice_preview_edition \
//     --prompt "Hello there. Please reply with the single word banana." --expect banana
//
// `--expect` is a case-insensitive regular expression tested against what the board said back;
// models say numbers as digits or as words, so ask for either: --expect "132|thirty-two".
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { credentials, disposeSessions, session } from "./client.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Proves a physical board end to end on the platform, out loud, through real air: a remote press,
 *  the prompt spoken out of this Mac's speaker, the transcripts checked. PROJECT (env) names the
 *  project, default prj-voice. */
export default async function voiceBoard(
  options: {
    /** The device's `itx.clients.` name. */
    device?: string;
    /** What this Mac's speaker says to the board. */
    prompt?: string;
    /** Case-insensitive regular expression tested against what the board said back. */
    expect?: string;
  } = {},
): Promise<void> {
  const PROJECT = process.env.PROJECT || "prj-voice";
  const DEVICE = options.device || "home_assistant_voice_preview_edition";
  const PROMPT = options.prompt || "Hello there. Please reply with the single word banana.";
  const EXPECT = new RegExp(options.expect || "banana", "i");
  const root = session().authenticate(credentials()).projects.get(PROJECT);
  await root.invoke(["itx", ["whoami"]]);
  const kit = root.clients[DEVICE];
  const before = await healthWithRetry(kit);
  if (before.callActive) throw new Error(`Device ${DEVICE} is already in a call; leave it alone.`);
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
  let ending = false;
  const errors: string[] = [];
  await call.subscribe({
    name: `voice-board-${askedAt}`,
    consumes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/utterance-transcribed",
      "events.iterate.com/voice-agent/answer-transcribed",
      "events.iterate.com/voice-agent/provider-error-reported",
      "events.iterate.com/voice-agent/provider-disconnected",
      "events.iterate.com/voice-agent/conversation-ended",
    ],
    target: (events: any[]) => {
      for (const raw of events) {
        const event = JSON.parse(JSON.stringify(raw));
        const p = event.payload ?? {};
        if (event.type === "events.iterate.com/voice-agent/spk-frame" && p.lastFrameOfAnswer)
          answers += 1;
        else if (event.type === "events.iterate.com/voice-agent/utterance-transcribed")
          heardUs += ` ${p.text}`;
        else if (event.type === "events.iterate.com/voice-agent/answer-transcribed")
          saidBack += ` ${p.text}`;
        else if (
          event.type === "events.iterate.com/voice-agent/provider-error-reported" ||
          event.type === "events.iterate.com/voice-agent/provider-disconnected"
        )
          errors.push(`${event.type}: ${JSON.stringify(p).slice(0, 200)}`);
        else if (event.type === "events.iterate.com/voice-agent/conversation-ended" && !ending)
          errors.push(`ended: ${String(p.reason)}`);
      }
    },
  });

  await sleep(3000);
  console.log(`speaking: ${PROMPT}`);
  await run("say", ["-r", "170", PROMPT]);

  let after: Health = before;
  let framesSent = 0;
  let spkWrites = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    after = await healthWithRetry(kit);
    if (after.conversation === streamPath) {
      framesSent = Math.max(framesSent, Number(after.framesSent ?? 0));
      spkWrites = Math.max(spkWrites, Number(after.spkWrites ?? 0));
    }
    if (EXPECT.test(saidBack) && answers > 0) break;
    await sleep(1000);
  }
  await sleep(1500);
  ending = true;
  try {
    await kit.conversation.end();
  } catch (error) {
    errors.push(`end: ${String(error).slice(0, 100)}`);
  }

  // A transcript alone does not prove playback. Only count health observations from this call.
  const failures = [
    ...errors,
    ...(!heardUs.trim() ? ["no microphone transcript"] : []),
    ...(!EXPECT.test(saidBack) ? [`reply did not match /${EXPECT.source}/i`] : []),
    ...(!framesSent ? ["no microphone frames sent"] : []),
    ...(!spkWrites ? ["no speaker writes"] : []),
    ...(!answers ? ["no completed speaker answer"] : []),
  ];
  const verdict = failures.length ? `FAIL: ${failures.join("; ")}` : "PASS";
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

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "voice-board" }).run();
