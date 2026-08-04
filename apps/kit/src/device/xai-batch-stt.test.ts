import { describe, expect, test, vi } from "vitest";
import { sliceOverlappingPcm16Windows, transcribePcm16WithXaiBatchStt } from "./xai-batch-stt.ts";

describe("xAI batch STT acoustic oracle", () => {
  test("covers a long PCM artifact with overlapping complete-sample windows", () => {
    /*
     * Repetitive count speech can make whole-file STT omit an intact span.
     * Every sample therefore needs at least one bounded decoding window, and
     * the final window must end exactly at the physical response boundary
     * instead of leaving an unjudged short tail.
     */
    const pcm = new Uint8Array(40 * 2);
    const windows = sliceOverlappingPcm16Windows({
      hopSamples: 10,
      pcm,
      windowSamples: 16,
    });

    expect(windows.map(({ endSample, startSample }) => [startSample, endSample])).toEqual([
      [0, 16],
      [10, 26],
      [20, 36],
      [24, 40],
    ]);
    expect(windows.every(({ pcm: window }) => window.byteLength === 32)).toBe(true);
  });

  test("uploads the retained raw PCM artifact with the file field last", async () => {
    /*
     * The acceptance artifact already exists in full before transcription.
     * Replaying it through realtime STT caused xAI to split one spoken number
     * across adjacent utterance boundaries, making an intact count look like a
     * duplicated sample. Batch STT is the provider's file-shaped API and has
     * no streaming segment assembler for our oracle to second-guess.
     *
     * xAI also documents that multipart fields placed after `file` may be
     * ignored. Checking insertion order here protects the quiet failure mode
     * where a 48 kHz raw artifact is decoded using the default 16 kHz rate.
     */
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init!.body as FormData;
      expect([...form.keys()]).toEqual(["audio_format", "sample_rate", "vad_threshold", "file"]);
      expect(form.get("audio_format")).toBe("pcm");
      expect(form.get("sample_rate")).toBe("48000");
      expect(form.get("vad_threshold")).toBe("0");
      const file = form.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect(await (file as Blob).arrayBuffer()).toEqual(Uint8Array.of(1, 2, 3, 4).buffer);
      return new Response(
        JSON.stringify({
          duration: 0.000_041_667,
          text: "one two three",
          words: [
            { end: 0.1, start: 0, text: "one" },
            { end: 0.2, start: 0.1, text: "two" },
            { end: 0.3, start: 0.2, text: "three" },
          ],
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });

    await expect(
      transcribePcm16WithXaiBatchStt({
        apiKey: "test-key",
        fetch: request,
        pcm: Uint8Array.of(1, 2, 3, 4),
        sampleRateHz: 48_000,
      }),
    ).resolves.toMatchObject({
      durationSeconds: 0.000_041_667,
      text: "one two three",
      words: [{ text: "one" }, { text: "two" }, { text: "three" }],
    });
    expect(request).toHaveBeenCalledOnce();
  });

  test("fails closed on malformed success and retains a bounded provider error", async () => {
    /*
     * An HTTP 200 without the documented transcript fields cannot become an
     * empty acoustic observation: that would blur provider schema drift with
     * a physically silent speaker. Conversely, a provider error body is useful
     * evidence but must not be copied without bound into a durable failure.
     */
    await expect(
      transcribePcm16WithXaiBatchStt({
        apiKey: "test-key",
        fetch: async () => new Response(JSON.stringify({ duration: 1 }), { status: 200 }),
        pcm: Uint8Array.of(1, 2),
        sampleRateHz: 16_000,
      }),
    ).rejects.toThrow("valid transcript text and words");

    await expect(
      transcribePcm16WithXaiBatchStt({
        apiKey: "test-key",
        fetch: async () => new Response("x".repeat(10_000), { status: 503 }),
        pcm: Uint8Array.of(1, 2),
        sampleRateHz: 16_000,
      }),
    ).rejects.toThrow(/503.*x{32}/u);
  });

  test("rejects incomplete PCM samples before making a request", async () => {
    const request = vi.fn<typeof fetch>();

    await expect(
      transcribePcm16WithXaiBatchStt({
        apiKey: "test-key",
        fetch: request,
        pcm: Uint8Array.of(1),
        sampleRateHz: 16_000,
      }),
    ).rejects.toThrow("complete samples");
    expect(request).not.toHaveBeenCalled();
  });
});
