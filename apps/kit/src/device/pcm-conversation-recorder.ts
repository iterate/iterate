import { createHash, type Hash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import type { PcmFrameObservation } from "../voice/device-pcm-proxy.ts";

const defaultMaximumStreamBufferBytes = 512 * 1024;

interface LaneState {
  bytes: number;
  frames: number;
  hash: Hash;
  path: string;
  stream: WriteStream;
}

export interface PcmConversationRecordingSummary {
  complete: boolean;
  failure: string | null;
  frameBytes: number;
  microphone: {
    bytes: number;
    frames: number;
    path: string;
    sha256: string;
  };
  outputDirectory: string;
  producedAt: string;
  sampleRateHz: number;
  speaker: {
    bytes: number;
    frames: number;
    path: string;
    sha256: string;
  };
  timelinePath: string;
}

export interface PcmConversationRecorderOptions {
  frameBytes: number;
  maximumStreamBufferBytes?: number;
  outputDirectory: string;
  sampleRateHz: number;
}

export interface PcmConversationMarker {
  event: string;
  microphoneByteOffset: number;
  microphoneFrames: number;
  observedAtMonotonicMs: number;
  speakerByteOffset: number;
  speakerFrames: number;
}

/**
 * A bounded, best-effort tee for the laptop-side physical test harness.
 *
 * This deliberately lives outside the Worker and firmware paths. Every PCM
 * callback copies once into a Node stream and returns; it never awaits disk.
 * If the stream's finite high-water mark is crossed, recording stops and the
 * artifact is marked incomplete instead of letting diagnostic memory grow or
 * applying disk backpressure to realtime audio.
 */
export class PcmConversationRecorder {
  readonly #frameBytes: number;
  readonly #microphone: LaneState;
  readonly #sampleRateHz: number;
  readonly #speaker: LaneState;
  readonly #timeline: WriteStream;
  readonly #timelinePath: string;
  #closePromise: Promise<PcmConversationRecordingSummary> | undefined;
  #closed = false;
  #failure: string | undefined;

  private constructor(options: PcmConversationRecorderOptions) {
    this.#frameBytes = options.frameBytes;
    this.#sampleRateHz = options.sampleRateHz;
    const maximumStreamBufferBytes =
      options.maximumStreamBufferBytes ?? defaultMaximumStreamBufferBytes;
    this.#microphone = createLane(
      join(options.outputDirectory, "microphone-uplink.pcm16le"),
      maximumStreamBufferBytes,
    );
    this.#speaker = createLane(
      join(options.outputDirectory, "speaker-downlink.pcm16le"),
      maximumStreamBufferBytes,
    );
    this.#timelinePath = join(options.outputDirectory, "timeline.jsonl");
    this.#timeline = createWriteStream(this.#timelinePath, {
      flags: "wx",
      highWaterMark: maximumStreamBufferBytes,
    });
    for (const stream of [this.#microphone.stream, this.#speaker.stream, this.#timeline]) {
      stream.on("error", (error) =>
        this.#recordFailure(`recording-stream-error: ${error.message}`),
      );
    }
  }

  static async create(options: PcmConversationRecorderOptions) {
    if (!Number.isSafeInteger(options.frameBytes) || options.frameBytes <= 0) {
      throw new TypeError("The conversation recorder frame size must be a positive integer.");
    }
    if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
      throw new TypeError("The conversation recorder sample rate must be a positive integer.");
    }
    const maximumStreamBufferBytes =
      options.maximumStreamBufferBytes ?? defaultMaximumStreamBufferBytes;
    if (
      !Number.isSafeInteger(maximumStreamBufferBytes) ||
      maximumStreamBufferBytes < options.frameBytes
    ) {
      throw new TypeError("The conversation recorder buffer must hold at least one PCM frame.");
    }
    await mkdir(options.outputDirectory, { recursive: true });
    return new PcmConversationRecorder(options);
  }

  observeFrame(observation: PcmFrameObservation) {
    if (this.#closed || this.#failure) return;
    if (observation.bytes.byteLength !== this.#frameBytes) {
      this.#recordFailure(
        `invalid-${observation.direction}-frame-size: ${observation.bytes.byteLength}`,
      );
      return;
    }
    const lane = observation.direction === "microphone-uplink" ? this.#microphone : this.#speaker;
    const byteOffset = lane.bytes;
    /*
     * `DevicePcmProxy` lends its frame view only for this callback. Node may
     * retain the write after return, so the copy is the ownership boundary
     * which prevents a reused provider/ring buffer from rewriting evidence.
     */
    const ownedFrame = Buffer.from(observation.bytes);
    const pcmAccepted = lane.stream.write(ownedFrame);
    lane.hash.update(ownedFrame);
    lane.bytes += ownedFrame.byteLength;
    lane.frames += 1;
    const timelineAccepted = this.#writeTimeline({
      byteLength: ownedFrame.byteLength,
      byteOffset,
      direction: observation.direction,
      frame: lane.frames,
      observedAtMonotonicMs: observation.observedAtMonotonicMs,
    });
    if (!pcmAccepted || !timelineAccepted) {
      this.#recordFailure(`recording-backpressure: ${observation.direction}`);
    }
  }

  recordEvent(event: string, fields: Readonly<Record<string, unknown>> = {}) {
    if (this.#closed || this.#failure) return undefined;
    if (!event) {
      this.#recordFailure("empty-conversation-event");
      return undefined;
    }
    /*
     * Host time locates an event approximately, but network jitter means it
     * cannot identify an exact media boundary. Snapshotting both lane offsets
     * at the marker lets an offline AEC oracle extract the exact clean-mic and
     * speaker PCM accepted before/after each phase without a second realtime
     * recorder or a guessed timestamp conversion.
     */
    const marker: PcmConversationMarker = {
      event,
      microphoneByteOffset: this.#microphone.bytes,
      microphoneFrames: this.#microphone.frames,
      observedAtMonotonicMs: performance.now(),
      speakerByteOffset: this.#speaker.bytes,
      speakerFrames: this.#speaker.frames,
    };
    if (!this.#writeTimeline({ ...fields, ...marker })) {
      this.#recordFailure(`recording-backpressure: event:${event}`);
      return undefined;
    }
    return marker;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#finish();
    return this.#closePromise;
  }

  async #finish(): Promise<PcmConversationRecordingSummary> {
    const streams = [this.#microphone.stream, this.#speaker.stream, this.#timeline];
    for (const stream of streams) stream.end();
    const results = await Promise.allSettled(streams.map(async (stream) => await finished(stream)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.#recordFailure(
          `recording-close-error: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        );
      }
    }
    const summary: PcmConversationRecordingSummary = {
      complete: this.#failure === undefined,
      failure: this.#failure ?? null,
      frameBytes: this.#frameBytes,
      microphone: summarizeLane(this.#microphone),
      outputDirectory: dirname(this.#timelinePath),
      producedAt: new Date().toISOString(),
      sampleRateHz: this.#sampleRateHz,
      speaker: summarizeLane(this.#speaker),
      timelinePath: this.#timelinePath,
    };
    /*
     * The summary is written last, so its existence means both PCM streams and
     * the chronology reached their terminal state. `complete: false` remains
     * a durable result rather than silently dropping a partial conversation.
     */
    await writeFile(
      join(dirname(this.#timelinePath), "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      { flag: "wx" },
    );
    return summary;
  }

  #recordFailure(reason: string) {
    this.#failure ??= reason;
  }

  #writeTimeline(value: Readonly<Record<string, unknown>>) {
    return this.#timeline.write(`${JSON.stringify(value)}\n`);
  }
}

function createLane(path: string, highWaterMark: number): LaneState {
  return {
    bytes: 0,
    frames: 0,
    hash: createHash("sha256"),
    path,
    stream: createWriteStream(path, { flags: "wx", highWaterMark }),
  };
}

function summarizeLane(lane: LaneState) {
  return {
    bytes: lane.bytes,
    frames: lane.frames,
    path: lane.path,
    sha256: lane.hash.digest("hex"),
  };
}
