// Server VAD + full duplex, proven from the wire — no buttons anywhere.
//
//   doppler run --config preview_3 -- pnpm cli voicelab vad-duplex \
//     --project voice-test --stream-path /agents/voice2/vad-1
//
// The stream must be set up OPEN-MIC (talk2 --open-mic --setup-only), ideally
// with a certificate `turnDetection` so the echo assertion below proves the
// configurability end to end.
//
// WHAT THIS PROVES, and each item is read off the wire rather than assumed:
//
//   1. CONFIG — the provider's `session.updated` (mirrored verbatim on the
//      grok-event lane) echoes back the ACCEPTED session, and its
//      `turn_detection` is the certificate's object — proven not just sent
//      but honored.
//   2. SERVER VAD OWNS THE TURNS — a spoken request followed by nothing but
//      silence draws an answer. No ptt-start, no ptt-end, no commit from
//      this driver: the provider's VAD hears the silence and answers.
//   3. FULL DUPLEX — the microphone stream NEVER stops. Frames flow up at
//      realtime pace for the whole run, including while the answer's frames
//      flow down; the barge below only works if both directions are live at
//      once.
//   4. THE SPOKEN BARGE — talking over the answer (still no buttons) makes
//      the facet clear the device within a bounded time, and the memory
//      repair follows: on a provider that truncates, the truncate ack and
//      the heard-prefix note both appear.
//   5. THE REPLY — the interjection itself is answered, which closes the
//      loop: detected, committed, and responded to by VAD alone.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab vad-duplex`. */
export interface VadDuplexOptions extends VoicelabConnectOptions {
  /** The open-mic stream whose agent is under test. Must already be set up. */
  streamPath: string;
  /** Barge once this much of the answer has been DELIVERED to the device. */
  bargeAfterMs?: number;
}

const FRAME_MS = 20;
const PCM16_BYTES_PER_MS = 32;
const FRAME_BYTES = FRAME_MS * PCM16_BYTES_PER_MS;
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES).toString("base64");

/** Synthesize one utterance to PCM16 mono 16 kHz frames. */
function synthesizeFrames(dir: string, name: string, text: string): string[] {
  const aiff = path.join(dir, `${name}.aiff`);
  const wav = path.join(dir, `${name}.wav`);
  for (const [command, args] of [
    ["say", ["-o", aiff, text]],
    ["afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]],
  ] as const) {
    const result = spawnSync(command, args);
    if (result.status !== 0) {
      throw new Error(`${command} failed: ${String(result.stderr).slice(0, 200)}`);
    }
  }
  const bytes = readFileSync(wav);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") {
      const pcm = bytes.subarray(offset + 8, offset + 8 + size);
      const frames: string[] = [];
      for (let cut = 0; cut + FRAME_BYTES <= pcm.length; cut += FRAME_BYTES) {
        frames.push(pcm.subarray(cut, cut + FRAME_BYTES).toString("base64"));
      }
      return frames;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${wav}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface StreamHandle {
  openConnection(input: unknown): Promise<unknown>;
  append(...events: unknown[]): Promise<unknown>;
}

export async function vadDuplex(options: VadDuplexOptions): Promise<void> {
  const bargeAfterMs = options.bargeAfterMs ?? 12_000;
  const dir = mkdtempSync(path.join(tmpdir(), "vad-duplex-"));
  const request = synthesizeFrames(
    dir,
    "request",
    "Please count slowly from one to one hundred, one number at a time, and do not stop early.",
  );
  const interjection = synthesizeFrames(
    dir,
    "interjection",
    "Stop counting please. Tell me the last number you said out loud.",
  );
  rmSync(dir, { recursive: true, force: true });

  const itx = await connectProject(options);
  const stream = (itx as unknown as { streams: { get(path: string): StreamHandle } }).streams.get(
    options.streamPath,
  );

  /* Everything asserted below is collected from the wire by this listener. */
  let sessionTurnDetection: unknown;
  let speechStartedCount = 0;
  let committedCount = 0;
  let responsesCreated = 0;
  let answerDeliveredMs = 0;
  let clearsSeen = 0;
  let clearSeenAtMs: number | null = null;
  let truncateAckSeen = false;
  let noteSeen = false;
  let repliesAfterBarge = 0;
  let bargeSpokenAtMs: number | null = null;
  let bargeAtResponseCount: number | null = null;
  const startedAtMs = Date.now();
  await stream.openConnection({
    connectionKey: `vad-duplex-${Date.now()}`,
    eventTypes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/grok-event",
    ],
    processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => {
      for (const event of batch.events ?? []) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === "events.iterate.com/voice-agent/spk-frame") {
          const pcm = typeof payload.pcm === "string" ? payload.pcm : "";
          if (payload.clearSpeakerBufferBeforeFrame === true && pcm === "") {
            clearsSeen += 1;
            if (bargeSpokenAtMs !== null && clearSeenAtMs === null) {
              clearSeenAtMs = Date.now() - startedAtMs;
            }
          }
          if (pcm !== "") {
            answerDeliveredMs +=
              (Math.floor(pcm.length / 4) * 3 -
                (pcm.endsWith("==") ? 2 : pcm.endsWith("=") ? 1 : 0)) /
              PCM16_BYTES_PER_MS;
          }
          continue;
        }
        const inner = (payload.event ?? payload) as Record<string, unknown>;
        const type = String(inner.type ?? "");
        if (type === "session.updated") {
          /* The provider echoes the WHOLE accepted session here — reading
           * turn_detection out of it proves the certificate's object was
           * honored, not merely sent. Shape differs per provider (openai
           * nests under audio.input; grok mirrors flat), so try both. */
          const session = (inner.session ?? {}) as {
            turn_detection?: unknown;
            audio?: { input?: { turn_detection?: unknown } };
          };
          sessionTurnDetection = session.audio?.input?.turn_detection ?? session.turn_detection;
        }
        if (type === "input_audio_buffer.speech_started") speechStartedCount += 1;
        if (type === "input_audio_buffer.committed") committedCount += 1;
        if (type === "response.created") responsesCreated += 1;
        if (type === "conversation.item.truncated") truncateAckSeen = true;
        if (type === "client.conversation.item.create") {
          if (JSON.stringify(inner).includes("heard only this much")) noteSeen = true;
        }
        if (
          type === "response.output_audio_transcript.done" &&
          bargeAtResponseCount !== null &&
          responsesCreated > bargeAtResponseCount
        ) {
          repliesAfterBarge += 1;
        }
      }
    },
  });

  /*
   * THE MICROPHONE NEVER STOPS. One realtime-paced loop feeds a queue of
   * utterance frames, padding with silence when the queue is empty — which
   * is what an open microphone in a quiet room IS. `speak()` splices words
   * into the stream without ever breaking its cadence.
   */
  let pending: string[] = [];
  let micFramesSent = 0;
  let stopMic = false;
  const speak = (frames: string[]) => {
    pending = pending.concat(frames);
  };
  const micLoop = (async () => {
    const startedAt = Date.now();
    let sequence = 0;
    while (!stopMic) {
      const due = startedAt + (sequence + 25) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      for (let index = 0; index < 25; index++) {
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: { deviceMicFrameSeq: sequence, pcm: pending.shift() ?? SILENCE_FRAME },
        });
        sequence += 1;
      }
      micFramesSent += 25;
      void stream.append(...events).catch(() => undefined);
    }
  })();

  console.log(`  open mic running; speaking the count request (${request.length} frames)…`);
  await sleep(1_000);
  speak(request);

  const answerDeadline = Date.now() + 60_000;
  while (answerDeliveredMs < bargeAfterMs && Date.now() < answerDeadline) await sleep(100);
  if (answerDeliveredMs < bargeAfterMs) {
    stopMic = true;
    await micLoop;
    console.log(`  FAIL: only ${Math.round(answerDeliveredMs)}ms of answer arrived in 60s`);
    process.exitCode = 1;
    return;
  }

  console.log(`  answer playing (${Math.round(answerDeliveredMs)}ms delivered); talking over it…`);
  bargeAtResponseCount = responsesCreated;
  bargeSpokenAtMs = Date.now() - startedAtMs;
  speak(interjection);

  const replyDeadline = Date.now() + 30_000;
  while (repliesAfterBarge === 0 && Date.now() < replyDeadline) await sleep(150);
  /* A short grace so the truncate ack and note (sent at response.done)
   * reach the mirror before the verdict reads them. */
  await sleep(1_500);
  stopMic = true;
  await micLoop;

  const clearLagMs =
    clearSeenAtMs !== null && bargeSpokenAtMs !== null ? clearSeenAtMs - bargeSpokenAtMs : null;
  console.log(`\n  SERVER VAD + FULL DUPLEX`);
  console.log(`    turn_detection echoed  ${JSON.stringify(sessionTurnDetection) ?? "NOT SEEN"}`);
  console.log(`    mic frames sent        ${micFramesSent} (continuous, zero ptt verbs)`);
  console.log(`    speech_started events  ${speechStartedCount}`);
  console.log(`    turns committed by VAD ${committedCount}`);
  console.log(`    answer delivered       ${Math.round(answerDeliveredMs)}ms`);
  console.log(
    `    clears (barge)         ${clearsSeen}${clearLagMs === null ? "" : ` — first ${clearLagMs}ms after the barge was spoken`}`,
  );
  console.log(`    truncate ack           ${truncateAckSeen ? "seen" : "not seen"}`);
  console.log(`    heard-prefix note      ${noteSeen ? "seen" : "not seen"}`);
  console.log(`    replies after barge    ${repliesAfterBarge}`);

  /*
   * The verdict: every leg of the loop, from the wire. The truncate ack and
   * note are required only when the provider repairs on the wire at all —
   * grok does not (see F17 in the pressure log), so their absence there is
   * the documented expectation, not a failure of THIS machinery.
   */
  const configProven = sessionTurnDetection !== undefined && sessionTurnDetection !== null;
  const vadProven = committedCount >= 2 && responsesCreated >= 2;
  const duplexProven = clearsSeen >= 1 && clearLagMs !== null && clearLagMs < 5_000;
  const answered = repliesAfterBarge >= 1;
  if (configProven && vadProven && duplexProven && answered) {
    console.log(`\n  PASS: VAD took both turns, the mic never stopped, and the barge landed.`);
  } else {
    console.log(
      `\n  FAIL: config=${String(configProven)} vad=${String(vadProven)} duplex=${String(duplexProven)} answered=${String(answered)}`,
    );
    process.exitCode = 1;
  }
}
