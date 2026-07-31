import { describe, expect, test } from "vitest";
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

describe("xAI streaming STT acoustic oracle", () => {
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
});
