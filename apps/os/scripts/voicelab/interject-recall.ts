// Does the agent KNOW it was interrupted?
//
// The scenario is exactly the one reported from a live session (2026-08-18):
// ask for a slow count to one hundred, barge in partway, then ask how far it
// got. A provider whose conversation still holds the ENTIRE generated answer
// swears it "counted all the way to one hundred" — the model remembers what
// it said, not what anybody heard. `conversation.item.truncate` is the
// provider-side repair; this command is the end-to-end check that it works,
// judged by the model's OWN follow-up answer.
//
// No microphone, no speakers, no hands: the two utterances are synthesized
// with macOS `say`, pressed into the stream exactly the way the probe
// presses, and the follow-up answer is read as TEXT from the verbatim
// `grok-event` lane (the provider transcribes its own speech —
// `response.output_audio_transcript.done`). Exit 0 when the reply owns the
// interruption; exit 1 when it claims the full count.
//
//   doppler run --config preview_3 -- pnpm cli voicelab interject-recall \
//     --project voice-test --stream-path /agents/voice2/<set-up-stream>
//
// The stream must already carry the agent (voicelab talk2 --setup-only).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for the interject-recall end-to-end check. */
export interface InterjectRecallOptions extends VoicelabConnectOptions {
  /** The stream whose agent is under test. Must already be set up. */
  streamPath: string;
  /**
   * Barge once this much of the count has been DELIVERED to the device.
   *
   * Late enough that the HEARD portion (delivered minus the ~2.6 s the
   * device buffers and the clear discards) contains several spoken numbers
   * past the answer's preamble — an honest reply must then NAME one. Barged
   * at 8 s, heard was ~4 s of mostly preamble, and "I didn't get to any
   * numbers yet" was true rather than the failure it looked like.
   */
  bargeAfterMs?: number;
}

const FRAME_MS = 20;
const PCM16_BYTES_PER_MS = 32;
const FRAME_BYTES = FRAME_MS * PCM16_BYTES_PER_MS;

/** Synthesize one utterance to PCM16 mono 16 kHz WAV and return its frames. */
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
  /* Minimal RIFF walk to the data chunk — afconvert's layout, not a general
   * WAV parser. */
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

/**
 * The largest count the reply mentions, in digits ("26") or words
 * ("twenty-six", "one hundred"). Null when no number appears at all —
 * which the verdict also treats as a failure, because "how far did you
 * get" answered without a number is a dodge, not recall.
 */
export function largestNumberMentioned(text: string): number | null {
  const lowered = text.toLowerCase().replaceAll("-", " ");
  let largest: number | null = null;
  const note = (value: number) => {
    if (largest === null || value > largest) largest = value;
  };
  for (const match of lowered.matchAll(/\b(\d{1,3})\b/g)) note(Number(match[1]));
  const units: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
  };
  const tens: Record<string, number> = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };
  const words = lowered.split(/[^a-z]+/);
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "hundred") note(100);
    if (word in units) note(units[word]!);
    if (word in tens) {
      const unit = units[words[index + 1] ?? ""] ?? 0;
      note(tens[word]! + (unit < 10 ? unit : 0));
    }
  }
  return largest;
}

export async function interjectRecall(options: InterjectRecallOptions): Promise<void> {
  const bargeAfterMs = options.bargeAfterMs ?? 15_000;
  const dir = mkdtempSync(path.join(tmpdir(), "interject-recall-"));
  const countFrames = synthesizeFrames(
    dir,
    "count",
    "Please count slowly from one to one hundred, one number at a time, and do not stop until you reach one hundred.",
  );
  const howFarFrames = synthesizeFrames(
    dir,
    "howfar",
    "Stop. How far did you actually get with the counting? Tell me the last number you said out loud.",
  );
  rmSync(dir, { recursive: true, force: true });

  const itx = await connectProject(options);
  const stream = (itx as unknown as { streams: { get(path: string): StreamHandle } }).streams.get(
    options.streamPath,
  );

  let deliveredMs = 0;
  let responsesCreated = 0;
  let truncatedSeen = false;
  let truncatedAudioEndMs: number | null = null;
  let noteText = "";
  let bargeAtResponseCount: number | null = null;
  const verdicts: { text: string; afterBarge: boolean }[] = [];
  await stream.openConnection({
    connectionKey: `interject-recall-${Date.now()}`,
    eventTypes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/grok-event",
    ],
    processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => {
      for (const event of batch.events ?? []) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === "events.iterate.com/voice-agent/spk-frame") {
          const pcm = typeof payload.pcm === "string" ? payload.pcm : "";
          if (pcm !== "") {
            deliveredMs +=
              (Math.floor(pcm.length / 4) * 3 -
                (pcm.endsWith("==") ? 2 : pcm.endsWith("=") ? 1 : 0)) /
              PCM16_BYTES_PER_MS;
          }
          continue;
        }
        const inner = (payload.event ?? payload) as Record<string, unknown>;
        const type = String(inner.type ?? "");
        if (type === "response.created") responsesCreated += 1;
        if (type === "conversation.item.truncated") {
          truncatedSeen = true;
          const value = Number(inner.audio_end_ms);
          if (Number.isFinite(value)) truncatedAudioEndMs = value;
        }
        if (type === "client.conversation.item.create") {
          noteText = String(inner.itemSummary ?? "");
        }
        if (type === "response.output_audio_transcript.done") {
          verdicts.push({
            text: String(inner.transcript ?? ""),
            afterBarge: bargeAtResponseCount !== null && responsesCreated > bargeAtResponseCount,
          });
        }
      }
    },
  });

  /** One full press, paced to real time, released in the final batch. */
  async function press(frames: string[]): Promise<void> {
    void stream
      .append({ type: "events.iterate.com/voice-agent/ptt-start", ephemeral: true, payload: {} })
      .catch(() => undefined);
    const pressedAt = Date.now();
    const batchSize = 25;
    for (let index = 0; index < frames.length; index += batchSize) {
      const due = pressedAt + Math.min(index + batchSize, frames.length) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      for (let offset = 0; offset < batchSize && index + offset < frames.length; offset++) {
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: {
            deviceMicFrameSeq: index + offset,
            pcm: frames[index + offset]!,
            capturedAtDeviceMs: pressedAt + (index + offset) * FRAME_MS,
          },
        });
      }
      if (index + batchSize >= frames.length) {
        await stream.append(...events, {
          type: "events.iterate.com/voice-agent/ptt-end",
          ephemeral: true,
          payload: {},
        });
      } else {
        void stream.append(...events).catch(() => undefined);
      }
    }
  }

  console.log(
    `  asking for the count (${((countFrames.length * FRAME_MS) / 1000).toFixed(1)}s press)…`,
  );
  await press(countFrames);

  const countDeadline = Date.now() + 45_000;
  while (deliveredMs < bargeAfterMs && Date.now() < countDeadline) await sleep(100);
  if (deliveredMs < bargeAfterMs) {
    console.log(`  FAIL: only ${Math.round(deliveredMs)}ms of count arrived in 45s`);
    process.exitCode = 1;
    return;
  }

  const heardAtBargeMs = deliveredMs;
  bargeAtResponseCount = responsesCreated;
  console.log(`  barging at ${Math.round(heardAtBargeMs)}ms of delivered count…`);
  await press(howFarFrames);

  const answerDeadline = Date.now() + 25_000;
  while (Date.now() < answerDeadline && !verdicts.some((verdict) => verdict.afterBarge)) {
    await sleep(150);
  }
  const reply = verdicts.find((verdict) => verdict.afterBarge);
  if (reply === undefined) {
    console.log("  FAIL: no answer to the interjection arrived in 25s");
    process.exitCode = 1;
    return;
  }

  /*
   * THE VERDICT IS THE MODEL'S OWN SENTENCE, judged against the clock.
   *
   * Two ways to be wrong, both observed live: without response.cancel it
   * claims the destination ("all the way to one hundred"); with cancel but
   * without conversation.item.truncate it claims the GENERATED frontier
   * (measured: "26" after eight seconds heard) — generation runs ahead of
   * playback, and the un-truncated item remembers audio nobody received.
   * Honest is: at most what the listener's clock allows, with slack for a
   * brisk counter.
   */
  const claimed = largestNumberMentioned(reply.text);
  /*
   * TWO YARDSTICKS, both from the wire. The truncate ack carries the
   * provider-confirmed HEARD milliseconds; the heard-prefix note (read back
   * from the flight recorder) carries what the model was TOLD it said. An
   * honest reply names a number, stays within the note it was given, and the
   * note itself must be sane against the clock — counting three-per-second
   * is the ceiling of plausible briskness, so a note past it means the
   * facet's window alignment broke, not the model.
   */
  const heardGroundTruthMs = truncatedAudioEndMs ?? heardAtBargeMs;
  const noteCeiling = largestNumberMentioned(noteText);
  const clockCeiling = Math.ceil((heardGroundTruthMs / 1_000) * 3) + 2;
  const allowance = Math.min(noteCeiling === null ? clockCeiling : noteCeiling + 2, clockCeiling);
  console.log(`  delivered at barge : ${Math.round(heardAtBargeMs)}ms of counting`);
  console.log(
    `  truncated event    : ${truncatedSeen ? `seen (heard ${truncatedAudioEndMs}ms)` : "NOT seen"}`,
  );
  console.log(`  note told the model: ${noteText.slice(0, 220) || "(no note seen)"}`);
  console.log(`  model's reply      : ${reply.text.trim().slice(0, 300)}`);
  console.log(`  claimed number     : ${claimed ?? "none found"} (allowance ≤ ${allowance})`);
  if (claimed === null || claimed > allowance) {
    console.log("  FAIL: the model remembers counting nobody heard");
    process.exitCode = 1;
    return;
  }
  console.log("  PASS: the reply owns the interruption");
}

interface StreamHandle {
  openConnection(options: {
    connectionKey: string;
    eventTypes: string[];
    processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => void;
  }): Promise<unknown>;
  append(
    ...events: { type: string; ephemeral?: true; payload: Record<string, unknown> }[]
  ): Promise<unknown>;
}
