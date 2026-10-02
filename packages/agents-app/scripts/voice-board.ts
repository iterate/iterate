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
//   node scripts/voice-board.ts --device home_assistant_voice_preview_edition \
//     --prompt "Hello there. Please reply with the single word banana." --expect banana
//
// `--expect` is a case-insensitive regular expression tested against what the board said back;
// models say numbers as digits or as words, so ask for either: --expect "132|thirty-two".
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { connect } from "./client.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the proof reads of the board's `health()` (voice_loop.c writes it; the rest passes
 *  through). The board keeps one mounted session across calls, so a health call that fails is a
 *  dropped device, and the proof fails with it. */
const Health = z.looseObject({
  callActive: z.boolean().optional(),
  conversation: z.string().optional(),
  framesSent: z.number().optional(),
  spkWrites: z.number().optional(),
  uptimeMs: z.number().optional(),
});

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
  using connection = await connect();
  // Untyped: the board's capability, `clients.<device>`, is whatever its firmware lends.
  const root: any = connection.session.projects.get(PROJECT);
  await root.invoke(["itx", ["whoami"]]);
  const kit = root.clients[DEVICE];
  const before = Health.parse(await kit.health());
  if (before.callActive) throw new Error(`Device ${DEVICE} is already in a call; leave it alone.`);
  console.log(
    `before: ${JSON.stringify({ framesSent: before.framesSent, spkWrites: before.spkWrites, uptimeMs: before.uptimeMs, callActive: before.callActive })}`,
  );

  const askedAt = Date.now();
  await kit.conversation.start();
  let callActiveMs: number | null = null;
  let streamPath = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    const health = Health.parse(await kit.health());
    if (health.callActive) {
      callActiveMs = Date.now() - askedAt;
      streamPath = health.conversation || "";
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
      "events.iterate.com/voice-agent/speaker-frame",
      "events.iterate.com/voice-agent/utterance-transcribed",
      "events.iterate.com/voice-agent/answer-transcribed",
      "events.iterate.com/voice-agent/provider-error-reported",
      "events.iterate.com/voice-agent/provider-disconnected",
      "events.iterate.com/voice-agent/call-ended",
    ],
    target: (events: any[]) => {
      for (const raw of events) {
        const event = JSON.parse(JSON.stringify(raw));
        const p = event.payload ?? {};
        if (event.type === "events.iterate.com/voice-agent/speaker-frame" && p.lastFrameOfAnswer)
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
        else if (event.type === "events.iterate.com/voice-agent/call-ended" && !ending)
          errors.push(`ended: ${String(p.reason)}`);
      }
    },
  });

  await sleep(3000);
  console.log(`speaking: ${PROMPT}`);
  await run("say", ["-r", "170", PROMPT]);

  let framesSent = 0;
  let spkWrites = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const after = Health.parse(await kit.health());
    if (after.conversation === streamPath) {
      framesSent = Math.max(framesSent, after.framesSent ?? 0);
      spkWrites = Math.max(spkWrites, after.spkWrites ?? 0);
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
  connection[Symbol.dispose]();
  process.exit(verdict === "PASS" ? 0 : 1);
}

void createCli(import.meta).run();
