// The audio probes' shared instrument: synthesized speech as wire frames,
// the stream surface they drive, and the base64 arithmetic they judge with.
//
// EXTRACTED, NOT DESIGNED. vad-duplex and interject-recall carried these ~90
// lines as verbatim copies (diff-identical modulo one comment), which meant
// one RIFF walk to fix in two places the day afconvert's layout surprises —
// and socket-lifetime carried a third copy of the StreamHandle shape. A
// helper module, deliberately NOT exported from ./index.ts: cli.ts turns
// index.ts exports into commands, and this is an instrument, not a command.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

export const FRAME_MS = 20;
export const PCM16_BYTES_PER_MS = 32;
export const FRAME_BYTES = FRAME_MS * PCM16_BYTES_PER_MS;

/** Synthesize one utterance to PCM16 mono 16 kHz frames, via macOS `say`. */
export function synthesizeFrames(dir: string, name: string, text: string): string[] {
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

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Decoded milliseconds of one base64 `spk-frame` payload, without decoding it. */
export function deliveredMsOf(pcm: string): number {
  return (
    (Math.floor(pcm.length / 4) * 3 - (pcm.endsWith("==") ? 2 : pcm.endsWith("=") ? 1 : 0)) /
    PCM16_BYTES_PER_MS
  );
}

/**
 * The stream surface the probes drive, typed to exactly what they call.
 * The typed superset of the three hand-written copies that used to exist:
 * the variadic `append` is what the probes' batched mic pushes need, and a
 * caller wanting less (socket-lifetime's single-event append) fits inside.
 */
export interface StreamHandle {
  openConnection(options: {
    connectionKey: string;
    eventTypes: string[];
    processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => void;
  }): Promise<unknown>;
  append(
    ...events: { type: string; ephemeral?: true; payload: Record<string, unknown> }[]
  ): Promise<unknown>;
}

/** Connect to the project and take the stream — the cast both probes copied. */
export async function openStream(
  options: VoicelabConnectOptions & { streamPath: string },
): Promise<StreamHandle> {
  const itx = await connectProject(options);
  return (itx as unknown as { streams: { get(path: string): StreamHandle } }).streams.get(
    options.streamPath,
  );
}
