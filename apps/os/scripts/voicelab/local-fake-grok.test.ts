import WebSocket from "ws";
import { afterEach, describe, expect, test } from "vitest";

import {
  LOCAL_FAKE_ANSWER_TRANSCRIPT,
  startLocalFakeGrok,
  type LocalFakeGrok,
} from "./local-fake-grok.ts";

describe("local fake Grok", () => {
  let fake: LocalFakeGrok | undefined;

  afterEach(async () => {
    await fake?.close();
  });

  test("completes a local realtime session from microphone PCM to speaker PCM", async () => {
    fake = await startLocalFakeGrok();
    const socket = new WebSocket(fake.url);
    const textEvents: { type?: string; transcript?: string }[] = [];
    let speakerBytes = 0;
    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("local provider proof timed out")), 2_000);
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          speakerBytes += Buffer.isBuffer(data)
            ? data.length
            : data instanceof ArrayBuffer
              ? data.byteLength
              : data.reduce((total, chunk) => total + chunk.length, 0);
          return;
        }
        const event = JSON.parse(data.toString()) as { type?: string; transcript?: string };
        textEvents.push(event);
        if (event.type === "session.created") {
          socket.send(JSON.stringify({ type: "session.update" }));
          socket.send(Buffer.alloc(640));
          socket.send(Buffer.alloc(640, 1));
          for (let index = 0; index < 12; index++) socket.send(Buffer.alloc(640));
        }
        if (event.type === "response.done") {
          clearTimeout(timeout);
          resolve();
        }
      });
      socket.on("error", reject);
    });

    await done;
    socket.close();

    expect(textEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.created",
        "session.updated",
        "input_audio_buffer.speech_started",
        "input_audio_buffer.speech_stopped",
        "conversation.item.input_audio_transcription.completed",
        "response.created",
        "response.output_audio_transcript.done",
        "response.done",
      ]),
    );
    expect(
      textEvents.find((event) => event.type === "response.output_audio_transcript.done")
        ?.transcript,
    ).toBe(LOCAL_FAKE_ANSWER_TRANSCRIPT);
    expect(speakerBytes).toBe(32_000);
    expect(fake.sessions).toMatchObject([
      {
        answers: 1,
        micBytes: 8_960,
        speakerBytes: 32_000,
        speechStarts: 1,
        speechStops: 1,
      },
    ]);
  });
});
