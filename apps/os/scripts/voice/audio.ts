// Mic capture and speaker playback via ffmpeg/ffplay child processes —
// prototype-grade audio I/O with zero native Node dependencies. macOS only
// for capture (avfoundation); playback works anywhere ffplay does.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AUDIO_SAMPLE_RATE } from "./realtime.ts";

const PCM_ARGS = ["-f", "s16le", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "1"];

export function startMicCapture(input: {
  /** avfoundation input device, e.g. ":0" for the default mic. */
  device: string;
  onChunk: (base64Pcm16: string) => void;
  onExit: (info: { code: number | null }) => void;
}) {
  const ffmpeg = spawn("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error"],
    ...["-f", "avfoundation", "-i", input.device],
    ...PCM_ARGS,
    "pipe:1",
  ]);
  ffmpeg.stdout.on("data", (chunk: Buffer) => input.onChunk(chunk.toString("base64")));
  ffmpeg.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  ffmpeg.on("exit", (code) => input.onExit({ code }));
  return { stop: () => ffmpeg.kill("SIGTERM") };
}

/**
 * A speaker that can be interrupted: barge-in kills the ffplay process so
 * buffered audio dies with it, and the next chunk lazily respawns a fresh one.
 */
export function createSpeaker() {
  let ffplay: ChildProcessWithoutNullStreams | null = null;

  const ensureProcess = () => {
    if (ffplay) return ffplay;
    ffplay = spawn("ffplay", [
      ...["-hide_banner", "-loglevel", "error"],
      ...["-nodisp", "-autoexit"],
      ...PCM_ARGS,
      ...["-i", "pipe:0"],
    ]);
    ffplay.on("exit", () => {
      ffplay = null;
    });
    return ffplay;
  };

  return {
    play(base64Pcm16: string) {
      ensureProcess().stdin.write(Buffer.from(base64Pcm16, "base64"));
    },
    stop() {
      ffplay?.kill("SIGKILL");
      ffplay = null;
    },
    dispose() {
      // Let buffered audio finish: close stdin so -autoexit ends the process.
      ffplay?.stdin.end();
      ffplay = null;
    },
  };
}
