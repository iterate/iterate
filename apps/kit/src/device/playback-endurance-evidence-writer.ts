import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type {
  M5StickS3PlaybackEnduranceRawMetricRecord,
  M5StickS3PlaybackEnduranceRawMetricSink,
} from "./m5sticks3-playback-endurance-target.ts";
import type { PlaybackEnduranceRunManifest } from "./playback-endurance-ladder.ts";

/**
 * Append-only host evidence for physical playback runs.
 *
 * Device callbacks arrive only once per second, so a synchronous regular-file
 * write gives each raw record a clear crash boundary without accumulating a
 * second unbounded Node queue. Manifests additionally fsync at stage
 * boundaries: they are infrequent and represent minutes of completed physical
 * work. Acoustic PCM remains in its recorder-owned artifact rather than being
 * copied into either JSONL file.
 */
export class PlaybackEnduranceJsonlEvidenceWriter
  implements Disposable, M5StickS3PlaybackEnduranceRawMetricSink
{
  readonly manifestsPath: string;
  readonly rawMetricsPath: string;
  readonly #manifestDescriptor: number;
  readonly #rawMetricsDescriptor: number;
  #closed = false;

  private constructor(
    manifestsPath: string,
    rawMetricsPath: string,
    manifestDescriptor: number,
    rawMetricsDescriptor: number,
  ) {
    this.manifestsPath = manifestsPath;
    this.rawMetricsPath = rawMetricsPath;
    this.#manifestDescriptor = manifestDescriptor;
    this.#rawMetricsDescriptor = rawMetricsDescriptor;
  }

  static open(outputDirectory: string) {
    if (!outputDirectory.trim() || outputDirectory.includes("\0")) {
      throw new Error("Playback endurance evidence requires a valid output directory.");
    }
    mkdirSync(outputDirectory, { recursive: true });
    const manifestsPath = join(outputDirectory, "manifests.jsonl");
    const rawMetricsPath = join(outputDirectory, "raw-metrics.jsonl");
    const manifestDescriptor = openSync(manifestsPath, "wx", 0o600);
    let rawMetricsDescriptor: number;
    try {
      rawMetricsDescriptor = openSync(rawMetricsPath, "wx", 0o600);
    } catch (error) {
      closeSync(manifestDescriptor);
      throw error;
    }
    return new PlaybackEnduranceJsonlEvidenceWriter(
      manifestsPath,
      rawMetricsPath,
      manifestDescriptor,
      rawMetricsDescriptor,
    );
  }

  append(record: M5StickS3PlaybackEnduranceRawMetricRecord) {
    this.#assertOpen();
    writeJsonLine(this.#rawMetricsDescriptor, record);
  }

  appendManifest(manifest: PlaybackEnduranceRunManifest) {
    this.#assertOpen();
    /*
     * The manifest certifies the callbacks that preceded it. Persist raw
     * evidence first: reversing these two barriers can leave a green manifest
     * after power loss while the metrics it claims to judge still exist only
     * in the host page cache.
     */
    fsyncSync(this.#rawMetricsDescriptor);
    writeJsonLine(this.#manifestDescriptor, manifest);
    /*
     * A process crash after stage completion must not erase the only judged
     * record for minutes of audio. This cost occurs six times per full ladder,
     * never on the device audio path or on each metrics callback.
     */
    fsyncSync(this.#manifestDescriptor);
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error("The playback endurance evidence writer is closed.");
    }
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#rawMetricsDescriptor);
    closeSync(this.#manifestDescriptor);
  }
}

function writeJsonLine(descriptor: number, value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Playback endurance evidence was not JSON-serializable.");
  }
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, written, bytes.byteLength - written);
    if (count <= 0) {
      throw new Error("Playback endurance evidence write made no forward progress.");
    }
    written += count;
  }
}
