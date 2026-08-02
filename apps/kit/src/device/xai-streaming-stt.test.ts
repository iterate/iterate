import { afterEach, describe, expect, test, vi } from "vitest";
import {
  transcribePcm16WithXaiStreamingStt,
  type XaiStreamingSttSocket,
} from "./xai-streaming-stt.ts";

class ScriptedSocket extends EventTarget implements XaiStreamingSttSocket {
  readonly binaryMessages: Uint8Array[] = [];
  readonly textMessages: string[] = [];

  close(): void {}

  send(value: string | Uint8Array): void {
    if (typeof value === "string") {
      this.textMessages.push(value);
      if (JSON.parse(value).type === "audio.done") {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              duration: 0.2,
              is_final: true,
              speech_final: true,
              text: "The physical Stick spoke clearly.",
              type: "transcript.partial",
              words: [],
            }),
          }),
        );
        /*
         * xAI currently emits an empty transcript.done after the useful final
         * partial. Replacing the speech-final text with that empty terminator
         * would make a successful acoustic oracle appear silent.
         */
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ duration: 0.2, text: "", type: "transcript.done", words: [] }),
          }),
        );
      }
      return;
    }
    this.binaryMessages.push(new Uint8Array(value));
  }
}

class SegmentedScriptedSocket extends EventTarget implements XaiStreamingSttSocket {
  close(): void {}

  send(value: string | Uint8Array): void {
    if (typeof value !== "string" || JSON.parse(value).type !== "audio.done") return;
    for (const message of [
      {
        is_final: true,
        speech_final: false,
        text: "Once upon a time",
        type: "transcript.partial",
        words: [
          { end: 0.4, start: 0, text: "Once" },
          { end: 0.8, start: 0.4, text: "upon" },
          { end: 1, start: 0.8, text: "a" },
          { end: 1.5, start: 1, text: "time" },
        ],
      },
      {
        is_final: true,
        speech_final: false,
        text: ", there was",
        type: "transcript.partial",
        words: [
          { end: 1.7, start: 1.5, text: "," },
          { end: 2, start: 1.7, text: "there" },
          { end: 2.3, start: 2, text: "was" },
        ],
      },
      /*
       * The speech-final event repeats the trailing window while supplying
       * its definitive last word. The real 73-second Stick artifact followed
       * this shape; retaining only this event lost the first minute, while
       * blindly concatenating it duplicated the overlap.
       */
      {
        is_final: true,
        speech_final: true,
        text: "there was a robot.",
        type: "transcript.partial",
        words: [
          { end: 2, start: 1.7, text: "there" },
          { end: 2.3, start: 2, text: "was" },
          { end: 2.5, start: 2.3, text: "a" },
          { end: 3, start: 2.5, text: "robot." },
        ],
      },
      { duration: 3, text: "", type: "transcript.done", words: [] },
    ]) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
  }
}

describe("xAI streaming STT acoustic oracle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("paces exact PCM bytes after readiness and retains the speech-final transcript", async () => {
    /*
     * This seam consumes only the Mac microphone artifact. Matching the raw
     * provider transcript through an independent STT connection proves that
     * recognizable speech crossed the physical speaker/air/microphone path;
     * it cannot be satisfied by perfect device counters alone.
     */
    const socket = new ScriptedSocket();
    const pcm = Uint8Array.from({ length: 19_200 }, (_, index) => index % 251);
    const sleeps: number[] = [];
    const resultPromise = transcribePcm16WithXaiStreamingStt({
      apiKey: "test-key",
      createSocket: (url, headers) => {
        expect(url.searchParams.get("sample_rate")).toBe("48000");
        expect(url.searchParams.get("vad_threshold")).toBe("0");
        expect(headers).toEqual({ authorization: "Bearer test-key" });
        queueMicrotask(() => {
          socket.dispatchEvent(new Event("open"));
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ id: "transcript-1", type: "transcript.created" }),
            }),
          );
        });
        return socket;
      },
      pcm,
      sampleRateHz: 48_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      timeoutMs: 1_000,
    });

    await expect(resultPromise).resolves.toMatchObject({
      durationSeconds: 0.2,
      text: "The physical Stick spoke clearly.",
    });
    expect(socket.binaryMessages).toHaveLength(2);
    expect(Buffer.concat(socket.binaryMessages.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(pcm),
    );
    expect(sleeps).toEqual([100]);
    expect(socket.textMessages).toEqual([JSON.stringify({ type: "audio.done" })]);
  });

  test("does not time out while a retained long reply is still being paced to STT", async () => {
    /*
     * The physical oracle deliberately replays the Mac-microphone artifact in
     * realtime so xAI sees the same cadence as live PCM. A fixed wall-clock
     * timeout shorter than the artifact therefore rejects a perfectly intact
     * long reply before `audio.done` can even be sent. The measured Stick
     * regression was a 70.86-second reply; 31 seconds is the smallest fixture
     * that crosses the historical 30-second ceiling without making this unit
     * test allocate a production-sized recording.
     */
    vi.useFakeTimers();
    const socket = new ScriptedSocket();
    const sampleRateHz = 1_000;
    const pcm = new Uint8Array(sampleRateHz * 2 * 31);
    const resultPromise = transcribePcm16WithXaiStreamingStt({
      apiKey: "test-key",
      createSocket: () => {
        queueMicrotask(() => {
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ id: "transcript-long", type: "transcript.created" }),
            }),
          );
        });
        return socket;
      },
      pcm,
      sampleRateHz,
      sleep: async (milliseconds) => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      },
    });

    await expect(resultPromise).resolves.toMatchObject({
      text: "The physical Stick spoke clearly.",
    });
  });

  test("assembles finalized chunks while replacing the speech-final overlap", async () => {
    const socket = new SegmentedScriptedSocket();
    const resultPromise = transcribePcm16WithXaiStreamingStt({
      apiKey: "test-key",
      createSocket: () => {
        queueMicrotask(() => {
          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ id: "transcript-segmented", type: "transcript.created" }),
            }),
          );
        });
        return socket;
      },
      pcm: new Uint8Array(200),
      sampleRateHz: 1_000,
      sleep: async () => {},
      timeoutMs: 1_000,
    });

    await expect(resultPromise).resolves.toMatchObject({
      text: "Once upon a time , there was a robot.",
      words: [
        { text: "Once" },
        { text: "upon" },
        { text: "a" },
        { text: "time" },
        { text: "," },
        { text: "there" },
        { text: "was" },
        { text: "a" },
        { text: "robot." },
      ],
    });
  });
});
