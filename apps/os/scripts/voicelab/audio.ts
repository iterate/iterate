// Audio I/O for the voice lab. 16kHz mono PCM16 throughout (Grok Voice's native rate).
// MicSource captures from the real mic via sox `rec`, or emits a PCM file paced in
// realtime followed by open-mic silence (deterministic, headless test input).
// PlayoutBuffer paces PCM to the speaker (sox `play`) in fixed ticks, counts underruns
// (audible gaps), and supports clear() for barge-in. With device=false it keeps the
// exact same accounting without touching an audio device.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";

export const SAMPLE_RATE = 16000;
export const BYTES_PER_SEC = SAMPLE_RATE * 2;
export const FRAME_MS = 20;
export const FRAME_BYTES = (BYTES_PER_SEC * FRAME_MS) / 1000; // 640

/** Expand G.711 mu-law to little-endian PCM16 for playout and duration accounting. */
export function mulawToPcm16(input: Buffer): Buffer {
  const output = Buffer.alloc(input.length * 2);
  for (let index = 0; index < input.length; index++) {
    const value = ~input[index]!;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    output.writeInt16LE(sign === 0 ? sample : -sample, index * 2);
  }
  return output;
}

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

/** Options for {@link MicSource}. */
export interface MicSourceOptions {
  /** Path to raw 16kHz mono PCM16 to play as the "mic"; omit for the real microphone. */
  syntheticPcmPath?: string;
  /** Silence emitted before the synthetic utterance starts (ms). */
  preSilenceMs?: number;
}

/** Emits `frame` (Buffer of FRAME_BYTES, captureTimeMs) every FRAME_MS. */
export class MicSource extends EventEmitter {
  /** Wall time (performance.now) when the last non-silence synthetic frame was emitted. */
  utteranceEndAt: number | null = null;
  /** One entry per drained synthetic utterance (performance.now at last speech frame). */
  utteranceEnds: number[] = [];
  /** When true, frames are emitted as silence instead of mic/synthetic content. */
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

  /** Queue more synthetic speech (barge-in tests inject a second utterance mid-call). */
  inject(pcm: Buffer, preSilenceMs = 0) {
    const pre = Buffer.alloc((BYTES_PER_SEC * preSilenceMs) / 1000);
    this.reservoir = Buffer.concat([this.reservoir, pre, pcm]);
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
          if (this.reservoir.length === 0) {
            this.utteranceEndAt = performance.now();
            this.utteranceEnds.push(this.utteranceEndAt);
          }
        } else {
          frame = Buffer.alloc(FRAME_BYTES);
        }
        tick++;
        this.emit("frame", this.muted ? Buffer.alloc(FRAME_BYTES) : frame, performance.now());
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
        this.emit("frame", this.muted ? Buffer.alloc(FRAME_BYTES) : frame, performance.now());
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

/** Options for {@link PlayoutBuffer}. */
export interface PlayoutBufferOptions {
  /** Actually play audio through sox `play`; false = accounting only. */
  device?: boolean;
  /** Silence written on startup to prime the output device (ms). */
  primeMs?: number;
}

/** Snapshot of playout quality counters. */
export interface PlayoutStats {
  underruns: number;
  underrunMs: number;
  cleared: number;
  maxDepthMs: number;
}

/**
 * Paced speaker sink with underrun accounting. write() enqueues PCM; a FRAME_MS
 * ticker drains at exactly realtime. An empty queue at tick time while audio is
 * in flight is an underrun == an audible gap. clear() models barge-in.
 */
export class PlayoutBuffer extends EventEmitter {
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

  constructor(private options: PlayoutBufferOptions = {}) {
    super();
    if (options.device !== false) {
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

  /** Barge-in: drop everything not yet paced out. Returns dropped milliseconds. */
  clear(): number {
    const droppedMs = (this.queuedBytes / BYTES_PER_SEC) * 1000;
    this.queue = [];
    this.queuedBytes = 0;
    this.active = false;
    this.cleared++;
    return droppedMs;
  }

  /** Natural end of a response: draining to empty is expected, not an underrun. */
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
          this.emit("underrun", { missingMs: ((FRAME_BYTES - got) / BYTES_PER_SEC) * 1000 });
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

/** Nearest-rank percentiles over a latency sample set. */
export function percentiles(values: number[]) {
  if (values.length === 0) return { n: 0 };
  const s = [...values].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return {
    n: s.length,
    min: +s[0]!.toFixed(1),
    p50: +pick(0.5).toFixed(1),
    p90: +pick(0.9).toFixed(1),
    p99: +pick(0.99).toFixed(1),
    max: +s[s.length - 1]!.toFixed(1),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
  };
}
