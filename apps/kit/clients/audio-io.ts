// Microphone sources and the paced speaker sink for the voice CLI.
//
// Derived from the proven voicelab harness audio (apps/os/scripts/voicelab/
// audio.ts): the same realtime-catch-up mic clock and the same underrun
// accounting, trimmed to what a product client needs. Real audio I/O rides
// sox (`rec`/`play`) so the client works on any machine with sox installed;
// without --device the sink still keeps exact accounting.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SAMPLE_RATE = 16000;
export const BYTES_PER_SEC = SAMPLE_RATE * 2;
export const FRAME_MS = 20;
export const FRAME_BYTES = (BYTES_PER_SEC * FRAME_MS) / 1000; // 640

const SOX_RAW_ARGS = [
  "-q",
  "-t",
  "raw",
  "-r",
  `${SAMPLE_RATE}`,
  "-e",
  "signed",
  "-b",
  "16",
  "-c",
  "1",
];

/** Render text to raw 16 kHz mono PCM16 via macOS `say` + sox. */
export function synthesizeUtterance(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iterate-voice-"));
  const aiff = path.join(dir, "utterance.aiff");
  const pcm = path.join(dir, "utterance.pcm");
  execFileSync("say", ["-v", "Samantha", "-o", aiff, text]);
  execFileSync("sox", [aiff, ...SOX_RAW_ARGS.slice(1), pcm]);
  return pcm;
}

export interface MicSourceOptions {
  /** Raw 16 kHz mono PCM16 file to stream as the microphone at realtime. */
  syntheticPcmPath?: string;
  /** Silence emitted before the synthetic utterance starts (ms). */
  preSilenceMs?: number;
}

/** Emits `frame` (Buffer of FRAME_BYTES) every FRAME_MS of audio time. */
export class MicSource extends EventEmitter {
  /** performance.now() at the last non-silence synthetic frame. */
  utteranceEndAt: number | null = null;
  muted = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private proc: ChildProcess | undefined;
  private reservoir = Buffer.alloc(0);

  constructor(private options: MicSourceOptions = {}) {
    super();
  }

  start() {
    if (this.options.syntheticPcmPath) this.startSynthetic(this.options.syntheticPcmPath);
    else this.startReal();
  }

  /** Queue more synthetic speech (multi-turn runs inject the next utterance). */
  inject(pcm: Buffer, preSilenceMs = 0) {
    const pre = Buffer.alloc((BYTES_PER_SEC * preSilenceMs) / 1000);
    this.reservoir = Buffer.concat([this.reservoir, pre, pcm]);
  }

  /** Whether queued synthetic speech is still draining. */
  pendingBytes(): number {
    return this.reservoir.length;
  }

  private startSynthetic(pcmPath: string) {
    this.inject(fs.readFileSync(pcmPath), this.options.preSilenceMs ?? 200);
    const t0 = performance.now();
    let tick = 0;
    const loop = () => {
      if (this.stopped) return;
      // Catch-up loop so timer drift never changes the audio clock.
      while ((tick + 1) * FRAME_MS <= performance.now() - t0 + FRAME_MS / 2) {
        let frame: Buffer;
        if (this.reservoir.length > 0) {
          const slice = this.reservoir.subarray(0, FRAME_BYTES);
          frame =
            slice.length === FRAME_BYTES
              ? Buffer.from(slice)
              : Buffer.concat([slice, Buffer.alloc(FRAME_BYTES - slice.length)]);
          this.reservoir = this.reservoir.subarray(slice.length);
          if (this.reservoir.length === 0) this.utteranceEndAt = performance.now();
        } else {
          frame = Buffer.alloc(FRAME_BYTES);
        }
        tick++;
        this.emit("frame", this.muted ? Buffer.alloc(FRAME_BYTES) : frame);
      }
      this.timer = setTimeout(loop, 5);
    };
    loop();
  }

  private startReal() {
    this.proc = spawn("rec", [...SOX_RAW_ARGS, "-", "--buffer", "512"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let pending = Buffer.alloc(0);
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= FRAME_BYTES) {
        const frame = Buffer.from(pending.subarray(0, FRAME_BYTES));
        pending = pending.subarray(FRAME_BYTES);
        this.emit("frame", this.muted ? Buffer.alloc(FRAME_BYTES) : frame);
      }
    });
    this.proc.on("exit", (code) => {
      if (!this.stopped) this.emit("error", new Error(`rec exited with ${code}`));
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.proc?.kill("SIGKILL");
  }
}

export interface PlayoutBufferOptions {
  /** Actually play audio through sox `play`; false = accounting only. */
  device?: boolean;
  /** Silence written on startup to prime the output device (ms). */
  primeMs?: number;
}

export interface PlayoutStats {
  underruns: number;
  underrunMs: number;
  cleared: number;
  maxDepthMs: number;
}

/**
 * Paced speaker sink with underrun accounting. write() enqueues PCM; a
 * FRAME_MS ticker drains at exactly realtime. An empty queue at tick time
 * while audio is in flight is an underrun — an audible gap. clear() models
 * barge-in; endOfResponse() makes the natural drain not count as one.
 */
export class PlayoutBuffer {
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private active = false;
  private finishing = false;
  private underruns = 0;
  private underrunMs = 0;
  private cleared = 0;
  private maxDepth = 0;
  private proc: ChildProcess | undefined;
  private tickTimer: NodeJS.Timeout;
  firstWriteAt: number | null = null;

  constructor(options: PlayoutBufferOptions = {}) {
    if (options.device === true) {
      this.proc = spawn("play", [...SOX_RAW_ARGS, "-", "--buffer", "1024"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      this.proc.stdin!.write(Buffer.alloc((BYTES_PER_SEC * (options.primeMs ?? 60)) / 1000));
    }
    this.tickTimer = setInterval(() => this.tick(), FRAME_MS);
  }

  write(buf: Buffer) {
    if (this.firstWriteAt === null) this.firstWriteAt = performance.now();
    this.queue.push(buf);
    this.queuedBytes += buf.length;
    this.active = true;
  }

  /** Barge-in: drop everything not yet paced out. Returns dropped ms. */
  clear(): number {
    const droppedMs = (this.queuedBytes / BYTES_PER_SEC) * 1000;
    this.queue = [];
    this.queuedBytes = 0;
    this.active = false;
    /*
     * The "expected drain" permission dies with the audio it was granted for.
     * It is normally spent by the drain completing, but a barge-in or a
     * superseding answer discards the queue first — and a permission left
     * standing would excuse the NEXT answer's first real underrun, so the one
     * counter that means "an audible gap" would silently under-report for the
     * rest of the run.
     */
    this.finishing = false;
    this.cleared++;
    return droppedMs;
  }

  /** Natural end of a response: draining to empty is expected. */
  endOfResponse() {
    this.finishing = true;
  }

  depthMs(): number {
    return (this.queuedBytes / BYTES_PER_SEC) * 1000;
  }

  private tick() {
    let need = FRAME_BYTES;
    const out: Buffer[] = [];
    while (need > 0 && this.queue.length > 0) {
      const head = this.queue[0]!;
      if (head.length <= need) {
        out.push(head);
        need -= head.length;
        this.queue.shift();
      } else {
        out.push(head.subarray(0, need));
        this.queue[0] = head.subarray(need);
        need = 0;
      }
    }
    const got = FRAME_BYTES - need;
    this.queuedBytes -= got;
    if (this.active) {
      this.maxDepth = Math.max(this.maxDepth, this.depthMs());
      if (got < FRAME_BYTES) {
        if (this.finishing && this.queue.length === 0) {
          this.active = false;
          this.finishing = false;
        } else {
          this.underruns++;
          this.underrunMs += ((FRAME_BYTES - got) / BYTES_PER_SEC) * 1000;
          if (this.queue.length === 0) this.active = false;
        }
      }
    }
    if (this.proc) {
      const silence = need > 0 ? Buffer.alloc(need) : null;
      this.proc.stdin!.write(silence ? Buffer.concat([...out, silence]) : Buffer.concat(out));
    }
  }

  stats(): PlayoutStats {
    return {
      underruns: this.underruns,
      underrunMs: Math.round(this.underrunMs),
      cleared: this.cleared,
      maxDepthMs: Math.round(this.maxDepth),
    };
  }

  stop() {
    clearInterval(this.tickTimer);
    this.proc?.stdin?.end();
    this.proc?.kill();
  }
}
