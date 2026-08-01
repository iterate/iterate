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
  /** screenshot | pull | turn | tone | call | hangup | status. */
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

/** The device's capability surface, as this script uses it. */
interface DeviceCapability {
  conversation: { start(): Promise<boolean>; hangUp(): Promise<boolean> };
  pushToTalk: { start(): Promise<boolean>; stop(): Promise<boolean> };
  setBackground(colour: string): Promise<boolean>;
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

const RECORDED_FILES = ["mic.pcm", "speaker.pcm", "call.log"];

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
    const stream = itx.streams.get(options.path ?? "/voicelab/dev-waveshare");
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
