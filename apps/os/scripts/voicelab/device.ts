// Drive and inspect an Iterate voice device (the Waveshare ESP32-S3 AMOLED)
// through its live capability at itx.kit.<name>. Everything here is an
// ordinary capability call — the device exposes the same surface to an agent,
// so nothing in this file is privileged.
//
//   doppler run --config preview_3 -- pnpm cli voicelab device screenshot --project prj_… --out screen.png
//   doppler run --config preview_3 -- pnpm cli voicelab device pull --project prj_… --out ./recording
//   doppler run --config preview_3 -- pnpm cli voicelab device turn --project prj_… --seconds 4
import fs from "node:fs";
import path_ from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab device`. */
export interface DeviceOptions extends VoicelabConnectOptions {
  /** journey | health | screenshot | pull | turn | tone | call | hangup | status. */
  action?: string;
  /** Capability the device mounts itself under (itx.kit.<name>). */
  name?: string;
  /** Where to write output: a PNG for screenshot, a directory for pull. */
  out?: string;
  /** How long to hold the talk button (`turn`) or play a tone (`tone`). */
  seconds?: number;
  /** Stream the device is on; only needed for `tone`. */
  path?: string;
}

const RECORDED_FILES = ["mic.pcm", "speaker.pcm", "call.log"];

/** The device's capability surface, as this script uses it. */
interface DeviceCapability {
  conversation: { start(): Promise<boolean>; hangUp(): Promise<boolean> };
  pushToTalk: { start(): Promise<boolean>; stop(): Promise<boolean> };
  setBackground(colour: string): Promise<boolean>;
  health(): Promise<Record<string, unknown>>;
  takeScreenshot(): Promise<{
    width: number;
    height: number;
    bytes: number;
    chunks: number;
  }>;
  readScreenshotChunk(index: number): Promise<ArrayBuffer>;
  recording: {
    status(): Promise<Record<string, unknown>>;
    size(name: string): Promise<number>;
    read(name: string, offset: number): Promise<ArrayBuffer>;
  };
}

export async function device(options: DeviceOptions) {
  const action = options.action ?? "status";
  using itx = await connectProject(options);
  const kit = (itx as unknown as { kit: Record<string, DeviceCapability> }).kit;
  const capability = kit[options.name ?? "waveshare"];
  if (!capability) throw new Error(`no device capability named ${options.name ?? "waveshare"}`);

  if (action === "status") {
    console.log(JSON.stringify(await capability.recording.status(), null, 2));
    return;
  }

  if (action === "health") {
    /*
     * The first thing to run when the device "isn't working". Every producer
     * on the device sits behind one gate, and when that gate is shut it goes
     * on answering calls like this one while starting no calls, sending no
     * audio and pushing no telemetry — so gateOpen is usually the whole
     * answer, and dev-stats cannot tell you because dev-stats is behind it.
     */
    console.log(JSON.stringify(await capability.health(), null, 2));
    return;
  }

  if (action === "screenshot") {
    const meta = await capability.takeScreenshot();
    const pixels = new Uint8Array(meta.bytes);
    let offset = 0;
    for (let index = 0; index < meta.chunks; index++) {
      const chunk = new Uint8Array(await capability.readScreenshotChunk(index));
      pixels.set(chunk, offset);
      offset += chunk.length;
    }
    const out = options.out ?? "device-screen.png";
    fs.writeFileSync(out, encodeRgb565Png(pixels, meta.width, meta.height));
    console.log(`${out}: ${meta.width}x${meta.height}`);
    return;
  }

  if (action === "pull") {
    const directory = options.out ?? "device-recording";
    fs.mkdirSync(directory, { recursive: true });
    for (const name of RECORDED_FILES) {
      const size = await capability.recording.size(name);
      if (size === 0) {
        console.log(`${name}: empty`);
        continue;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const chunk = new Uint8Array(await capability.recording.read(name, offset));
        if (chunk.length === 0) break;
        bytes.set(chunk.subarray(0, size - offset), offset);
        offset += chunk.length;
      }
      // PCM lands as a WAV so it opens in anything; the log stays text.
      const isPcm = name.endsWith(".pcm");
      const target = path_.join(directory, isPcm ? name.replace(/\.pcm$/, ".wav") : name);
      fs.writeFileSync(
        target,
        isPcm ? wrapWav(bytes.subarray(0, offset)) : bytes.subarray(0, offset),
      );
      console.log(`${target}: ${offset} bytes${isPcm ? ` (${(offset / 32000).toFixed(2)}s)` : ""}`);
    }
    return;
  }

  if (action === "turn") {
    const heldMs = Math.round((options.seconds ?? 3) * 1000);
    await capability.pushToTalk.start();
    console.error(`talk button held for ${heldMs}ms — speak now`);
    await new Promise((resolve) => setTimeout(resolve, heldMs));
    await capability.pushToTalk.stop();
    console.error("released; the answer follows on the device");
    return;
  }

  if (action === "tone") {
    /*
     * A known signal down the same path the assistant's voice takes: stream
     * events -> device inbox -> decode -> speaker buffer -> I2S -> codec. No
     * call, no provider, no VAD — so anything audible in the result belongs
     * to the transport or the device, and a recording of the room can be
     * compared against what was sent sample for sample.
     */
    const stream = itx.streams.get(options.path ?? "/agents/voice/device");
    const seconds = options.seconds ?? 20;
    const frames = Math.round((seconds * 1000) / 20);
    const samplesPerFrame = 320; // 20ms at 16kHz
    let phase = 0;
    const started = Date.now();
    let sequence = 0;
    for (let batch = 0; batch * 5 < frames; batch++) {
      const events = [];
      for (let index = 0; index < 5 && batch * 5 + index < frames; index++) {
        const pcm = Buffer.alloc(samplesPerFrame * 2);
        for (let sample = 0; sample < samplesPerFrame; sample++) {
          // 440Hz at -6dBFS: loud enough to hear over a room, far from clipping.
          phase += (2 * Math.PI * 440) / 16_000;
          pcm.writeInt16LE(Math.round(Math.sin(phase) * 16_384), sample * 2);
        }
        events.push({
          type: "voicelab/spk-frame" as const,
          ephemeral: true as const,
          payload: {
            callId: "tone",
            pcm: pcm.toString("base64"),
            seq: sequence++,
            t: Date.now(),
          },
        });
      }
      await stream.append(...events);
      // Realtime pacing: five 20ms frames is 100ms of audio.
      const due = started + (batch + 1) * 100;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    console.error(`sent ${sequence} frames (${(sequence * 20) / 1000}s of 440Hz)`);
    return;
  }

  if (action === "journey") {
    /*
     * The whole user journey, driven the way a person drives it and observed
     * the way a person observes it: press call, wait for it to actually be
     * live, hold talk, let go, wait for the answer. Every step is timed and
     * screenshotted, because "it takes forever" and "the screen is stuck"
     * are only diagnosable if you can see WHICH step stalled and what the
     * device was showing while it did.
     */
    const outDir = options.out ?? "journey";
    fs.mkdirSync(outDir, { recursive: true });
    const stream = itx.streams.get(options.path ?? "/agents/voice/device");
    const steps: { step: string; ms: number; note?: string }[] = [];
    /*
     * Every device call is time-bounded. A capability call that never
     * resolves — which happens when the device resets or its session drops
     * mid-request — would otherwise hang the whole harness silently, and a
     * test tool that can hang is worse than no test tool: it turns "the
     * device is broken" into "the run produced nothing".
     */
    const withTimeout = async <T>(label: string, run: () => Promise<T>, ms = 20_000) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          run(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const shot = async (name: string) => {
      try {
        const meta = await withTimeout("takeScreenshot", () => capability.takeScreenshot());
        const pixels = new Uint8Array(meta.bytes);
        let offset = 0;
        for (let index = 0; index < meta.chunks; index++) {
          const chunk = new Uint8Array(
            await withTimeout(`chunk ${index}`, () => capability.readScreenshotChunk(index)),
          );
          pixels.set(chunk, offset);
          offset += chunk.length;
        }
        fs.writeFileSync(
          path_.join(outDir, `${name}.png`),
          encodeRgb565Png(pixels, meta.width, meta.height),
        );
      } catch (error) {
        steps.push({ ms: 0, note: String(error).slice(0, 80), step: `screenshot:${name}` });
      }
    };
    const timed = async <T>(step: string, run: () => Promise<T>) => {
      const started = Date.now();
      try {
        const value = await withTimeout(step, run);
        steps.push({ ms: Date.now() - started, step });
        return value;
      } catch (error) {
        steps.push({ ms: Date.now() - started, note: String(error).slice(0, 90), step });
        return undefined;
      }
    };

    console.error("journey: screenshotting idle screen");
    await shot("1-idle");
    await timed("hangUp (clear any stale call)", () => capability.conversation.hangUp());
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.error("journey: pressing call");
    await timed("press call", () => capability.conversation.start());
    // Wait for the call to be LIVE, not merely requested.
    {
      const started = Date.now();
      let live = false;
      while (Date.now() - started < 60_000) {
        const status = (await withTimeout("status", () => capability.recording.status()).catch(
          () => ({}),
        )) as { recording?: boolean };
        if (status.recording === true) {
          live = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      steps.push({
        ms: Date.now() - started,
        note: live ? "call went live" : "NEVER WENT LIVE",
        step: "wait for call live",
      });
    }
    await shot("2-call-live");

    console.error("journey: holding talk");
    await timed("hold talk", () => capability.pushToTalk.start());
    await new Promise((resolve) => setTimeout(resolve, (options.seconds ?? 3) * 1000));
    await shot("3-talking");
    await timed("release talk", () => capability.pushToTalk.stop());

    /*
     * Watch the STREAM for the answer, not the device's SD-card log. The log
     * is a diagnostic that can be absent (no card, a card that wedged) and
     * an absent diagnostic must never read as a failed call — that reported
     * "NO ANSWER" for a call whose answer was plainly on the screen.
     */
    {
      const started = Date.now();
      let answered = false;
      let spokenText = "";
      const connection = await stream.openConnection({
        connectionKey: `journey-${Date.now()}`,
        eventTypes: ["voicelab/grok-event"],
        processEventBatch: (batch: { events: { payload?: unknown }[] }) => {
          for (const event of batch.events) {
            const inner = (event.payload as { event?: { type?: string; delta?: string } })?.event;
            if (inner?.type === "response.output_audio_transcript.delta") {
              spokenText += inner.delta ?? "";
            }
            if (inner?.type === "response.done") answered = true;
          }
        },
      });
      while (Date.now() - started < 45_000 && !answered) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      connection.close();
      steps.push({
        ms: Date.now() - started,
        note: answered ? `answered: ${spokenText.slice(0, 70)}` : "NO ANSWER",
        step: "wait for answer",
      });
    }
    await shot("4-answered");

    let log = "";
    const size = await capability.recording.size("call.log");
    for (let offset = 0; offset < size; ) {
      const chunk = new Uint8Array(await capability.recording.read("call.log", offset));
      if (chunk.length === 0) break;
      log += String.fromCharCode(...chunk);
      offset += chunk.length;
    }
    console.log(JSON.stringify({ callLog: log.split("\n"), screenshots: outDir, steps }, null, 2));
    return;
  }

  if (action === "call" || action === "hangup") {
    const started = action === "call";
    await (started ? capability.conversation.start() : capability.conversation.hangUp());
    console.error(started ? "call requested" : "hung up");
    return;
  }

  throw new Error(`unknown action: ${action}`);
}

/** 16kHz mono S16LE, the format both device lanes record in. */
function wrapWav(pcm: Uint8Array): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/** Minimal truecolour PNG; the device sends RGB565 little-endian. */
function encodeRgb565Png(pixels: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let out = 0;
  for (let y = 0; y < height; y++) {
    raw[out++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 2;
      const value = pixels[index]! | (pixels[index + 1]! << 8);
      raw[out++] = Math.round((((value >> 11) & 0x1f) * 255) / 31);
      raw[out++] = Math.round((((value >> 5) & 0x3f) * 255) / 63);
      raw[out++] = Math.round(((value & 0x1f) * 255) / 31);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typed) : crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Node before 20.12 has no zlib.crc32. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

if (process.env.VOICELAB_DEVICE_SELFTEST === "1") {
  // The PNG encoder is the one piece here with no device in the loop.
  const png = encodeRgb565Png(new Uint8Array([0x00, 0xf8, 0xe0, 0x07]), 2, 1);
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("bad PNG magic");
  console.log("device.ts selftest ok");
}
