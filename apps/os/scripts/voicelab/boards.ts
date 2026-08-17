// Prove every connected board end to end, out loud, through real air.
//
// The other device scripts here drive ONE board and mostly read counters. This
// one asks the whole question a person asks: can I say something to this thing
// and have it answer? So it speaks the prompt out of the Mac's own SPEAKER and
// requires the board's own MICROPHONE to have heard it — nothing is injected
// past the hardware, because the hardware is what keeps breaking.
//
// A pass needs four separate facts, and no counter here can be true for the
// wrong reason on its own:
//
//   a. the call became active (and how long that took, which is the thing
//      people complain about);
//   b. microphone frames actually left the device (`framesSent`);
//   c. an answer actually reached its speaker (`spkWrites`, `spkAnswerStarts`);
//   d. the provider transcribed the spoken words and the board answered them.
//
//   doppler run --config prd -- pnpm cli voicelab boards --project voice-test
//   doppler run --config prd -- pnpm cli voicelab boards --project voice-test --only stackchan
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import {
  type VoicelabConnectOptions,
  connectProject,
  deviceCapability,
  deviceClientPath,
} from "./connect.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Options for `pnpm cli voicelab boards`. */
export interface BoardsOptions extends VoicelabConnectOptions {
  /** Capability name of a single board to prove; omit to prove all of them. */
  only?: string;
  /** What to say out loud. Must be something a one-word answer can follow. */
  prompt?: string;
  /** The word the answer has to contain for the transcript check to pass. */
  expect?: string;
  /** Where to write the evidence JSON. */
  out?: string;
  /**
   * Speak a second time OVER the first answer, and check the device reacts.
   *
   * The one-turn proof above cannot see the failure people actually report,
   * which is not "the device is silent" but "it talks over me and will not
   * stop". That needs two utterances where the second lands while the speaker
   * is still playing the first, and it needs the DEVICE's own barge-in
   * counters as the witness — a transcript cannot tell you whether the board
   * stopped playing, only what the model eventually said.
   */
  barge?: boolean;
}

/** One board, as this harness has to drive it. */
interface Board {
  /** The capability name it mounts itself under: `itx.kit.<name>`. */
  name: string;
  label: string;
  /**
   * Whether the microphone has to be held open around the prompt.
   *
   * The two boards with echo cancellation — StackChan in software, the HA
   * Voice PE in its XMOS DSP — run open-mic on the provider's server VAD.
   * The two without it are push-to-talk, and speaking at one of those
   * without holding the button proves nothing.
   */
  pushToTalk: boolean;
}

const BOARDS: readonly Board[] = [
  { label: "StackChan CoreS3", name: "stackchan", pushToTalk: false },
  { label: "M5StickS3", name: "m5stick-s3", pushToTalk: true },
  { label: "HA Voice PE", name: "home-assistant-voice-preview-edition", pushToTalk: false },
  { label: "Waveshare AMOLED", name: "waveshare", pushToTalk: true },
];

/** What one board's attempt produced. Written out whole, pass or fail. */
interface BoardResult {
  label: string;
  verdict: string;
  callActiveMs?: number | null;
  streamPath?: string;
  /** Second-utterance evidence, present only when --barge ran. */
  barge?: {
    /** Speaker writes seen at the moment the interruption was spoken. */
    spokeOverPlaybackAt: number;
    /** Answers the device abandoned mid-play, which is what stopping IS. */
    superseded: number;
    /** A second answer started after the interruption. */
    answeredAgain: boolean;
    verdict: string;
  };
  deviceHeard?: string;
  deviceSaid?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/**
 * Reads health across a remount.
 *
 * Adopting a fresh conversation REMOUNTS the device, and for a second or two
 * its capability genuinely is not there. That is the handshake working, not a
 * broken board, so every read rides over it instead of reporting a device that
 * is in fact fine.
 */
async function healthWithRetry(
  kit: { health(): Promise<Record<string, unknown>> },
  attempts = 20,
): Promise<Record<string, unknown>> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await kit.health();
    } catch (error) {
      last = error;
      await sleep(1500);
    }
  }
  throw last;
}

export async function boards(options: BoardsOptions) {
  const prompt = options.prompt ?? "Hello there. Please reply with the single word banana.";
  const expect = (options.expect ?? "banana").toLowerCase();
  const chosen = options.only ? BOARDS.filter((board) => board.name === options.only) : BOARDS;
  if (chosen.length === 0) {
    throw new Error(
      `no board named ${options.only}; known: ${BOARDS.map((b) => b.name).join(", ")}`,
    );
  }
  const results: Record<string, BoardResult> = {};

  for (const board of chosen) {
    const record: BoardResult = { label: board.label, verdict: "FAIL: did not run" };
    results[board.name] = record;
    console.error(`\n=== ${board.label} (${deviceClientPath(board.name)}) ===`);
    /* One connection per board: a socket that died proving the last board must
     * not be reported as this board's fault. */
    using itx = await connectProject(options);
    const kit = deviceCapability<any>(itx, board.name);
    if (!kit) {
      record.verdict = `FAIL: nothing mounted at kit.${board.name}`;
      console.error(`  ${record.verdict}`);
      continue;
    }

    try {
      const before = await healthWithRetry(kit);
      record.before = {
        framesSent: before.framesSent,
        spkWrites: before.spkWrites,
        uptimeMs: before.uptimeMs,
      };

      const askedAt = Date.now();
      await kit.conversation.start();

      let callActiveMs: number | null = null;
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await healthWithRetry(kit)).callActive) {
          callActiveMs = Date.now() - askedAt;
          break;
        }
        await sleep(500);
      }
      record.callActiveMs = callActiveMs;
      console.error(`  call active after ${callActiveMs} ms`);
      if (callActiveMs === null) {
        record.verdict = "FAIL: call never became active";
        continue;
      }

      /*
       * WATCH BEFORE SPEAKING. The provider's events are ephemeral — they
       * reach connections that already existed when they were appended and
       * nobody else — so a transcript read afterwards is always empty, which
       * reads as a device that said nothing rather than an instrument opened
       * too late. The device says which conversation it is on, so there is no
       * guessing which stream to open.
       */
      const streamPath = String((await healthWithRetry(kit)).conversation ?? "");
      record.streamPath = streamPath;
      let heardUs = "";
      let saidBack = "";
      const connection = await itx.streams.get(streamPath).openConnection({
        connectionKey: `boards-${board.name}-${askedAt}`,
        eventTypes: ["events.iterate.com/voice-agent/grok-event"],
        processEventBatch: (batch: { events?: { payload?: unknown }[] }) => {
          for (const event of batch.events ?? []) {
            const inner = (
              event.payload as { event?: { type?: string; delta?: string; transcript?: string } }
            )?.event;
            if (inner?.type === "response.output_audio_transcript.delta") {
              saidBack += inner.delta ?? "";
            }
            if (inner?.type?.includes("input_audio_transcription")) {
              heardUs += inner.transcript ?? inner.delta ?? "";
            }
          }
        },
      });

      try {
        /* Let the greeting finish rather than talking over it: an interrupted
         * greeting is a different test, and a flakier one. */
        await sleep(4000);
        if (board.pushToTalk) await kit.pushToTalk.start();
        await run("say", ["-r", "170", prompt]);
        if (board.pushToTalk) await kit.pushToTalk.stop();

        let answered = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          const health = await healthWithRetry(kit);
          record.after = {
            batches: health.batches,
            framesSent: health.framesSent,
            micCaptured: health.micCaptured,
            micDropped: health.micDropped,
            spkAnswerStarts: health.spkAnswerStarts,
            spkStarvedMs: health.spkStarvedMs,
            spkWrites: health.spkWrites,
          };
          if (Number(health.spkWrites) > 0 && Number(health.framesSent) > 0) {
            answered = true;
            break;
          }
          await sleep(1000);
        }
        console.error(`  ${JSON.stringify(record.after)}`);
        record.deviceHeard = heardUs.trim();
        record.deviceSaid = saidBack.trim();
        const matched =
          heardUs.toLowerCase().includes(expect) || saidBack.toLowerCase().includes(expect);
        /*
         * "audio only" is deliberately not a pass. Frames moving in both
         * directions proves the lanes are alive; it does not prove the device
         * understood anything, and those are different claims.
         */
        record.verdict = answered
          ? matched
            ? "PASS"
            : "PASS (audio moved, no word match)"
          : "FAIL: no answer reached the speaker";
        console.error(`  heard: ${JSON.stringify(record.deviceHeard)}`);
        console.error(`  said:  ${JSON.stringify(record.deviceSaid)}`);
        console.error(`  ${record.verdict}  stream=${streamPath}`);

        if (options.barge === true && answered) {
          /*
           * THE SECOND TURN, spoken deliberately EARLY.
           *
           * The point is to be talking while the board is talking, so the
           * prompt above must be one with a long answer and this must not
           * wait for it to finish. `spkAnswerStarts` at the moment of the
           * interruption is recorded so the evidence says whether playback
           * was actually in flight — an interruption of silence proves
           * nothing and must not be allowed to look like a pass.
           */
          const during = await healthWithRetry(kit);
          const startsBefore = Number(during.spkAnswerStarts ?? 0);
          const supersededBefore = Number(during.spkSupersededMidplay ?? 0);

          if (board.pushToTalk) await kit.pushToTalk.start();
          await run("say", ["-r", "170", "Stop. Say the word pineapple instead."]);
          if (board.pushToTalk) await kit.pushToTalk.stop();

          let answeredAgain = false;
          let superseded = 0;
          for (let attempt = 0; attempt < 30; attempt++) {
            const health = await healthWithRetry(kit);
            superseded = Number(health.spkSupersededMidplay ?? 0) - supersededBefore;
            if (Number(health.spkAnswerStarts ?? 0) > startsBefore) {
              answeredAgain = true;
              break;
            }
            await sleep(1000);
          }
          /*
           * Two separate claims, kept separate. "It heard me while it was
           * talking" is the barge-in; "it then said something new" is the
           * second turn. A board that stops but never answers again is a
           * different defect from one that answers without ever stopping.
           *
           * THERE WERE THREE COLUMNS AND ONLY TWO CLAIMS. `bargeIns` stood
           * beside `superseded` and reported what `answeredAgain` already did:
           * the firmware incremented it on the `drop` that STARTS an answer, so
           * it moved once per reply whether or not anything was interrupted.
           * The counter is gone from the device; what is left here is the
           * honest pair — audio was thrown away mid-play, and a new answer
           * arrived.
           */
          const noticed = superseded > 0;
          record.barge = {
            spokeOverPlaybackAt: Number(during.spkWrites ?? 0),
            superseded,
            answeredAgain,
            verdict:
              noticed && answeredAgain
                ? "PASS"
                : answeredAgain
                  ? "PASS (answered again, but the device logged no interruption)"
                  : noticed
                    ? "FAIL: stopped for the interruption and never answered it"
                    : "FAIL: talked straight through the interruption",
          };
          console.error(
            `  barge: superseded+${String(superseded)} ` +
              `answeredAgain=${String(answeredAgain)} — ${record.barge.verdict}`,
          );
          record.deviceSaid = saidBack.trim();
        }
      } finally {
        connection.close();
      }
    } catch (error) {
      record.verdict = `FAIL: ${String(error).slice(0, 200)}`;
      console.error(`  ${record.verdict}`);
    } finally {
      try {
        await kit.conversation.end();
      } catch {
        /* Ending a call that is already gone is not a failure of this proof. */
      }
    }
  }

  if (options.out) fs.writeFileSync(options.out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  return results;
}
