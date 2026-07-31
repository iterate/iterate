import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PcmConversationRecorder } from "./pcm-conversation-recorder.ts";

describe("PCM conversation recorder", () => {
  test("retains exact independent microphone and speaker lanes with a bounded timeline", async () => {
    /*
     * The physical oracle needs to distinguish what the Stick captured from
     * what userspace returned. Concatenating directions or recording room
     * audio would make that attribution impossible. Pin the raw byte files,
     * offsets, hashes, and semantic turn marker as one durable artifact.
     */
    const outputDirectory = await mkdtemp(join(tmpdir(), "iterate-kit-conversation-test-"));
    const recorder = await PcmConversationRecorder.create({
      frameBytes: 4,
      outputDirectory,
      sampleRateHz: 16_000,
    });

    recorder.recordEvent("pushToTalk.started", { source: "physical", turn: 1 });
    recorder.observeFrame({
      bytes: Uint8Array.of(1, 2, 3, 4),
      direction: "microphone-uplink",
      observedAtMonotonicMs: 10,
    });
    recorder.observeFrame({
      bytes: Uint8Array.of(5, 6, 7, 8),
      direction: "speaker-downlink",
      observedAtMonotonicMs: 20,
    });
    const summary = await recorder.close();

    expect(new Uint8Array(await readFile(summary.microphone.path))).toEqual(
      Uint8Array.of(1, 2, 3, 4),
    );
    expect(new Uint8Array(await readFile(summary.speaker.path))).toEqual(Uint8Array.of(5, 6, 7, 8));
    expect(summary).toMatchObject({
      complete: true,
      frameBytes: 4,
      microphone: { bytes: 4, frames: 1 },
      sampleRateHz: 16_000,
      speaker: { bytes: 4, frames: 1 },
    });
    const timeline = (await readFile(join(outputDirectory, "timeline.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(timeline).toEqual([
      expect.objectContaining({ event: "pushToTalk.started", source: "physical", turn: 1 }),
      expect.objectContaining({
        byteLength: 4,
        byteOffset: 0,
        direction: "microphone-uplink",
        observedAtMonotonicMs: 10,
      }),
      expect.objectContaining({
        byteLength: 4,
        byteOffset: 0,
        direction: "speaker-downlink",
        observedAtMonotonicMs: 20,
      }),
    ]);
  });
});
