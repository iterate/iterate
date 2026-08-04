// Find the loudest volume this board plays cleanly, by measuring rather than
// guessing.
//
//   doppler run --config preview_3 -- pnpm cli voicelab loudness \
//     --project <slug> --name waveshare
//
// THE METHOD: play a 440 Hz tone through the board's speaker, record the room
// on THIS MAC's microphone, and compare the second harmonic against the
// fundamental. A speaker driven past its amplifier does not get louder, it
// gets dirtier — the fundamental stops rising while the harmonics climb — so
// the honest measure of "as loud as possible" is the highest setting whose
// harmonics are still buried AND whose fundamental is still rising.
//
// The Mac's microphone rather than the board's own, because the board's
// recorder writes to an SD card and there is no card in the slot: every
// recording reads back empty, silently. Put the board near the Mac and run
// this; it needs the room, not a cable.
//
// WHY THIS SCRIPT EXISTS. That comment recorded two data points, volume 60
// and volume 100, and the shipped setting is 85 — a value between two
// measurements rather than one of them. Nobody had measured what 85 actually
// does, and "as loud as possible" cannot be answered by interpolation.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab loudness`. */
export interface LoudnessOptions extends VoicelabConnectOptions {
  /** Capability name of the board, as mounted (kit.<name>). */
  name?: string;
  /** Stream the device is listening on. */
  path?: string;
  /** Volumes to try, loudest last. */
  volumes?: string;
  /** Seconds of tone per volume. */
  seconds?: number;
  /**
   * The call id the device answers to.
   *
   * Frames carrying any other id are IGNORED by the playout classifier — that
   * is its job — so a tone sent under a made-up id is silently discarded and
   * the sweep measures an empty room. The Waveshare's is "wsdev".
   */
  callId?: string;
}

const SAMPLE_RATE = 16_000;
const TONE_HZ = 440;
const FRAME_SAMPLES = 320;
/**
 * Harmonic distance that still counts as clean.
 *
 * The board measured -34.9 dB at volume 60 and -16.8 dB at 100, so the knee
 * sits between them. -30 dB keeps the result on the good side of that knee
 * with margin for a different room.
 */
const CLEAN_HARMONIC_DB = -30;

/**
 * Record the room for `seconds` and return the samples.
 *
 * `rec` rather than a library: this needs one mono 16 kHz WAV from the
 * default input, and shelling out to the tool that already does that keeps
 * the measurement inspectable — the WAV is left on disk to be listened to if
 * a number ever looks wrong.
 */
function recordRoom(seconds: number, label: string): Int16Array {
  const target = path.join(os.tmpdir(), `iterate-loudness-${label}.wav`);
  execFileSync(
    "rec",
    ["-q", "-c", "1", "-r", "16000", "-b", "16", target, "trim", "0", String(seconds)],
    {
      stdio: "ignore",
    },
  );
  const raw = fs.readFileSync(target);
  return new Int16Array(raw.buffer, raw.byteOffset + 44, Math.floor((raw.length - 44) / 2));
}

/**
 * Energy at `hz`, by direct projection rather than a full transform.
 *
 * One bin is all this needs and a Goertzel-style projection says exactly what
 * it measures; an FFT here would be a library dependency and a windowing
 * argument in exchange for bins nobody reads.
 */
function energyAt(samples: Int16Array, hz: number): number {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < samples.length; index++) {
    const angle = (2 * Math.PI * hz * index) / SAMPLE_RATE;
    real += samples[index]! * Math.cos(angle);
    imaginary += samples[index]! * Math.sin(angle);
  }
  return Math.sqrt(real * real + imaginary * imaginary) / samples.length;
}

/** Send `seconds` of 440 Hz down the same path the assistant's voice takes. */
async function playTone(
  stream: { append(...events: unknown[]): Promise<unknown> },
  seconds: number,
  callId: string,
): Promise<void> {
  const frames = Math.round((seconds * 1000) / 20);
  const started = Date.now();
  let phase = 0;
  let sequence = 0;
  for (let batch = 0; batch * 5 < frames; batch++) {
    const events = [];
    for (let index = 0; index < 5 && batch * 5 + index < frames; index++) {
      const pcm = Buffer.alloc(FRAME_SAMPLES * 2);
      for (let sample = 0; sample < FRAME_SAMPLES; sample++) {
        phase += (2 * Math.PI * TONE_HZ) / SAMPLE_RATE;
        // -6 dBFS: the level the speaker path actually carries in speech.
        pcm.writeInt16LE(Math.round(Math.sin(phase) * 16_384), sample * 2);
      }
      events.push({
        type: "voice-agent/spk-frame",
        ephemeral: true,
        payload: { callId, pcm: pcm.toString("base64"), seq: sequence++, t: Date.now() },
      });
    }
    await stream.append(...events);
    const wait = started + (batch + 1) * 100 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

interface DeviceCapability {
  setVolume(percent: number): Promise<unknown>;
}

export async function loudness(options: LoudnessOptions) {
  using itx = await connectProject(options);
  const kit = (itx as unknown as { kit: Record<string, DeviceCapability> }).kit;
  const capability = kit[options.name ?? "waveshare"];
  if (!capability) throw new Error(`no device capability named ${options.name ?? "waveshare"}`);
  const stream = itx.streams.get(options.path ?? "/agents/voice/device") as unknown as {
    append(...events: unknown[]): Promise<unknown>;
  };
  const seconds = options.seconds ?? 4;
  const volumes = (options.volumes ?? "60,75,85,95,100")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 100);

  console.log(
    `tone ${String(TONE_HZ)}Hz, ${String(seconds)}s per volume, recorded on this Mac's microphone\n`,
  );
  console.log(`  vol  fundamental   2nd harmonic   verdict`);
  const results: { volume: number; level: number; harmonic: number }[] = [];
  for (const volume of volumes) {
    await capability.setVolume(volume);
    // The tone starts first so the recorder never catches its leading edge,
    // where the class-D amplifier is still settling and would read as
    // distortion the steady state does not have.
    const playing = playTone(stream, seconds + 1, options.callId ?? "wsdev");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const captured = recordRoom(seconds - 1, String(volume));
    await playing;
    if (captured.length < SAMPLE_RATE) {
      console.log(
        `  ${String(volume).padStart(3)}  (captured ${String(captured.length)} samples — too few to judge)`,
      );
      continue;
    }
    const fundamental = energyAt(captured, TONE_HZ);
    const second = energyAt(captured, TONE_HZ * 2);
    const harmonicDb = 20 * Math.log10(second / (fundamental || 1));
    const levelDb = 20 * Math.log10(fundamental / 32768);
    results.push({ harmonic: harmonicDb, level: levelDb, volume });
    console.log(
      `  ${String(volume).padStart(3)}  ${levelDb.toFixed(1).padStart(8)} dB  ${harmonicDb.toFixed(1).padStart(10)} dB   ${
        harmonicDb <= CLEAN_HARMONIC_DB ? "clean" : "DISTORTING"
      }`,
    );
  }

  const clean = results.filter((entry) => entry.harmonic <= CLEAN_HARMONIC_DB);
  const loudest = clean.at(-1);
  console.log(
    loudest === undefined
      ? `\nnothing measured clean — the tone may not be reaching the speaker at all`
      : `\nloudest clean setting: volume ${String(loudest.volume)} (${loudest.level.toFixed(1)} dBFS at the mic)`,
  );
  if (process.env.ITERATE_LOUDNESS_KEEP !== "1" && loudest !== undefined) {
    await capability.setVolume(loudest.volume);
    console.log(`left the board at ${String(loudest.volume)}`);
  }
}
